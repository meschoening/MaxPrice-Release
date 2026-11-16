import { z } from "zod";
import { reducedGatewayRecordSchema, type ReducedGatewayRecord } from "@maxprice/shared";
import { loadDurably, writeDurably } from "./durable-file";

// gateway-pending.json — the Gateway records this client holds (ADR-0141 §5,
// D3), in three parts:
//
// - `pending`: reduced records offered for matching (a drain's, or the Hub
//   feed's) and not yet matched, each with its credential's email hash where
//   this machine read one, and when it was received. A record is matched
//   within 24 hours of receipt or not at all (`GATEWAY_PENDING_TTL_MS`),
//   because a line can be written after its record arrives.
// - `seen`: every `executionId` offered, with when it was first received, kept
//   7 days (`GATEWAY_SEEN_TTL_MS`, the Hub feed's window), so a record drained
//   twice, or served again by the feed, is never matched twice.
// - `outbox`: the records this client drained in fallback, matched or not,
//   kept until the Hub acknowledges them in a push-up. Reduced records only:
//   the email hash never travels (ADR-0137 §1).
//
// LOCAL ONLY. Written only once something was offered or put in the outbox:
// an install with no Gateway writes nothing. Each write is a durable replace.
// An unreadable file is kept as `.bak` and the store starts empty.

export const GATEWAY_PENDING_TTL_MS = 24 * 60 * 60 * 1000;
export const GATEWAY_SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const HASH = /^[0-9a-f]{64}$/;

// A record offered for matching: the reduced record, and the credential's
// email hash where the machine that read it is this one (a drain here). A
// record from the Hub's feed carries no hash.
export type GatewayOffer = { reduced: ReducedGatewayRecord; emailHash?: string };
export type PendingGatewayRecord = GatewayOffer & { receivedAt: number };

const pendingSchema = z.object({
  reduced: reducedGatewayRecordSchema,
  emailHash: z.string().regex(HASH).optional(),
  receivedAt: z.number().finite(),
});
const fileSchema = z.object({
  version: z.literal(1),
  pending: z.array(z.unknown()),
  seen: z.record(z.number().finite()),
  outbox: z.array(z.unknown()),
});

export type GatewayPendingStore = {
  // Admits each offer whose `executionId` was not seen within 7 days, as
  // pending, received now. Returns the admitted ones; the rest are ignored.
  admit: (offers: readonly GatewayOffer[]) => PendingGatewayRecord[];
  // Every pending record, oldest receipt first.
  pending: () => readonly PendingGatewayRecord[];
  // Removes pending records (matched, or consumed as ignored); their ids stay
  // seen.
  remove: (executionIds: Iterable<string>) => void;
  // Drops pending records received more than 24 hours ago, and seen ids more
  // than 7 days old. Returns the expired pending records.
  expire: () => PendingGatewayRecord[];
  // The fallback drain's outbox (ADR-0141 §5): records kept until acked.
  addOutbox: (records: readonly ReducedGatewayRecord[]) => void;
  outbox: () => readonly ReducedGatewayRecord[];
  ack: (executionIds: Iterable<string>) => void;
};

export function createGatewayPendingStore(opts: {
  path: string;
  now?: () => number;
}): GatewayPendingStore {
  const now = opts.now ?? Date.now;
  // By executionId, in receipt order (Map insertion order).
  const pending = new Map<string, PendingGatewayRecord>();
  const seen = new Map<string, number>();
  const outbox = new Map<string, ReducedGatewayRecord>();

  load();

  function load(): void {
    const file = loadDurably(opts.path, fileSchema, "gateway-pending.json");
    if (file === null) return;
    for (const [id, at] of Object.entries(file.seen)) seen.set(id, at);
    for (const candidate of file.pending) {
      const p = pendingSchema.safeParse(candidate);
      if (!p.success) continue;
      pending.set(p.data.reduced.executionId, {
        reduced: p.data.reduced,
        ...(p.data.emailHash === undefined ? {} : { emailHash: p.data.emailHash }),
        receivedAt: p.data.receivedAt,
      });
      if (!seen.has(p.data.reduced.executionId)) {
        seen.set(p.data.reduced.executionId, p.data.receivedAt);
      }
    }
    for (const candidate of file.outbox) {
      const r = reducedGatewayRecordSchema.safeParse(candidate);
      if (r.success) outbox.set(r.data.executionId, r.data);
    }
  }

  function write(): void {
    try {
      writeDurably(
        opts.path,
        JSON.stringify({
          version: 1,
          pending: [...pending.values()],
          seen: Object.fromEntries(seen),
          outbox: [...outbox.values()],
        }),
      );
    } catch (err) {
      console.error("[sidecar] gateway-pending.json write failed:", err);
    }
  }

  return {
    admit: (offers) => {
      const at = now();
      const admitted: PendingGatewayRecord[] = [];
      for (const offer of offers) {
        const id = offer.reduced.executionId;
        if (seen.has(id)) continue;
        seen.set(id, at);
        const emailHash =
          offer.emailHash !== undefined && HASH.test(offer.emailHash) ? offer.emailHash : undefined;
        const record: PendingGatewayRecord = {
          reduced: offer.reduced,
          ...(emailHash === undefined ? {} : { emailHash }),
          receivedAt: at,
        };
        pending.set(id, record);
        admitted.push(record);
      }
      if (admitted.length > 0) write();
      return admitted;
    },
    pending: () => [...pending.values()],
    remove: (executionIds) => {
      let changed = false;
      for (const id of executionIds) if (pending.delete(id)) changed = true;
      if (changed) write();
    },
    expire: () => {
      const at = now();
      const expired: PendingGatewayRecord[] = [];
      for (const [id, record] of pending) {
        if (at - record.receivedAt > GATEWAY_PENDING_TTL_MS) {
          pending.delete(id);
          expired.push(record);
        }
      }
      let changed = expired.length > 0;
      for (const [id, firstAt] of seen) {
        if (at - firstAt > GATEWAY_SEEN_TTL_MS && !pending.has(id)) {
          seen.delete(id);
          changed = true;
        }
      }
      if (changed) write();
      return expired;
    },
    addOutbox: (records) => {
      let changed = false;
      for (const r of records) {
        if (outbox.has(r.executionId)) continue;
        outbox.set(r.executionId, r);
        changed = true;
      }
      if (changed) write();
    },
    outbox: () => [...outbox.values()],
    ack: (executionIds) => {
      let changed = false;
      for (const id of executionIds) if (outbox.delete(id)) changed = true;
      if (changed) write();
    },
  };
}
