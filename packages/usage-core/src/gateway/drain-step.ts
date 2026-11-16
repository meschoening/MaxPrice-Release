import type { GatewayState } from "@maxprice/shared";
import {
  credentialEmailHashes,
  inferStatisticsOff,
  reduceCliProxyRecord,
  type CliProxyApi,
  type CliProxyCredential,
  type ReducedCliProxyRecord,
} from "./cliproxyapi";

// One drain of one Gateway (ADR-0141 §5, §7): the step the Hub's drainer
// (apps/hub gateway-drainer.ts) and a client's fallback drain (apps/sidecar
// gateway-client.ts) share. The credential list is read at the first drain
// and every CREDENTIALS_REFRESH_MS after: it maps each record's `auth_index`
// to its credential's email hash, and two successive reads with no record
// read between them while a credential's counters rose say `statistics-off`
// (`inferStatisticsOff`). The queue is then read dry, each record reduced
// with the caller's resolver (a failed attempt skipped, §2), and the reduced
// records handed to the caller's sink. The caller owns the state's storage,
// its scheduling, and what a sink does with a record.

export const CREDENTIALS_REFRESH_MS = 5 * 60_000;

// What one Gateway's drain keeps between drains. The caller's own record
// carries these fields; the step reads and updates them in place.
export type GatewayDrainBaseline = {
  credentials: CliProxyCredential[] | null;
  credentialsAt: number | null;
  // Records read (readable or not) since the last credential read.
  readSinceCredentials: number;
  statisticsOff: boolean;
  // When a drain last read a record, this run.
  lastRecordAt: string | null;
};

export type GatewayDrainStep = {
  api: CliProxyApi;
  // The Gateway's URL host, for lines.
  host: string;
  // `[hub]` or `[sidecar]`.
  logPrefix: string;
  now: () => number;
  refreshMs: number;
  // True once the Gateway was removed (or the drainer stopped) mid-drain.
  gone: () => boolean;
  // Runs after each fresh credential read, before the queue (the Hub
  // resolves its keys' emails then). Must not reject.
  afterCredentials?: () => Promise<void>;
  // The Account resolver for this drain's records, taken once per drain
  // after the queue is read.
  resolver: () => (emailHash: string) => string | undefined;
  // Takes the drain's reduced records, when there are any.
  sink: (records: ReducedCliProxyRecord[]) => void;
  // The caller's state transition (it logs a change).
  setState: (state: GatewayState) => void;
  warn: (line: string) => void;
};

// Drains `g` once. Answers how many reduced records the sink took (0 when it
// was not called).
export async function drainGatewayOnce(
  g: GatewayDrainBaseline,
  step: GatewayDrainStep,
): Promise<number> {
  const { api, now } = step;
  if (g.credentialsAt === null || now() - g.credentialsAt >= step.refreshMs) {
    const listed = await api.listCredentials();
    if (step.gone()) return 0;
    if (!listed.ok) {
      step.setState(listed.failure);
      return 0;
    }
    if (g.credentials !== null) {
      g.statisticsOff = inferStatisticsOff(
        g.credentials,
        listed.credentials,
        g.readSinceCredentials,
      );
    }
    g.credentials = listed.credentials;
    g.credentialsAt = now();
    g.readSinceCredentials = 0;
    if (step.afterCredentials !== undefined) {
      await step.afterCredentials();
      if (step.gone()) return 0;
    }
  }
  const drained = await api.drain();
  // Records popped are the caller's to keep, removed Gateway or not; with
  // none popped a removed Gateway's drain ends here.
  if (step.gone() && drained.records.length === 0) return 0;
  const read = drained.records.length + drained.unreadable;
  if (read > 0) {
    g.readSinceCredentials += read;
    g.lastRecordAt = new Date(now()).toISOString();
    g.statisticsOff = false;
  }
  const credentials = credentialEmailHashes(g.credentials ?? []);
  const resolve = step.resolver();
  const reduced: ReducedCliProxyRecord[] = [];
  for (const record of drained.records) {
    const r = reduceCliProxyRecord(record, { credentials, resolve });
    if (r !== null) reduced.push(r);
  }
  if (reduced.length > 0) step.sink(reduced);
  if (drained.unreadable > 0) {
    step.warn(
      `${step.logPrefix} Gateway ${step.host}: dropped ${drained.unreadable} unreadable record(s)`,
    );
  }
  if (!step.gone()) {
    step.setState(drained.failure ?? (g.statisticsOff ? "statistics-off" : "draining"));
  }
  return reduced.length;
}
