import { useState } from "react";
import { useLiveStatus } from "@/state/use-live-status";
import {
  discoverOrgsViaSidecar,
  writeCredential,
  pushCredentialToSidecar,
} from "@/lib/usage-credential";
import {
  formatWallClock,
  usageConnectionDot,
  usageConnectionLabel,
  usageConnectionTextClass,
  type TimeDisplay,
} from "@maxprice/shared";
import { useTimeDisplay } from "@/state/use-settings";
import { isStale, STALE_USAGE_LINE } from "@/lib/stale-status";
import { cn } from "@/lib/utils";
import { dotVariant } from "@/lib/dot-variant";

// Settings → Claude account (ADR-0023). Paste a claude.ai sessionKey cookie;
// we discover the org, pick the subscription org by capability, store
// { sessionKey, orgId } in the OS keychain, and push it to the sidecar.
// Live connection state comes from the `status:changed` SSE snapshot, which
// the sidecar updates on every poll — success AND failure.
//
// M6 (T7): the status line is a triad dot + the frozen labels from
// usage-status.ts — including the deliberate `expired` divergence (amber dot,
// red text); inputs/buttons are the T1 glass pieces; validation errors stay
// bare `--bad` text lines under their control.

// Capabilities that mark a subscription org (vs an API-only org). We pick the
// first org that has any of these; a multi-subscription-org picker is a
// follow-up.
const SUBSCRIPTION_CAPS = ["claude_max", "claude_pro", "chat"];

// Format an ISO 8601 capturedAt as a clock time for the status line ("last
// reading 3:42 PM"). An unparseable value falls back to the raw string rather
// than rendering "Invalid Date".
//
// Before ADR-0060 this line was the app's one rogue clock: it read the HOST
// zone (never the Settings timezone) and took whatever hour cycle the host
// locale implied, so it could disagree with every other time on screen in both
// zone and shape. Routing it through `formatWallClock` fixes both at once —
// there is no longer a way to render a clock time without naming its zone.
function formatSampleTime(iso: string, display: TimeDisplay): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatWallClock(d, display);
}

export function UsageConnectionSection(): React.ReactElement {
  const connection = useLiveStatus((s) => s.usageConnection);
  const lastSampleAt = useLiveStatus((s) => s.usageLastSampleAt);
  const display = useTimeDisplay();
  // THE STALE RULE (lib/stale-status), shared verbatim with the sidebar foot —
  // which renders simultaneously with this page. `usageConnection` is a mirror
  // of sidecar-owned state refreshed only by `status:changed` frames, so once
  // the SSE channel is gone it holds its last value forever and a green
  // "Connected" starts asserting something nobody has confirmed since the drop.
  //
  // Only the stale rule is shared. The foot's sticky-connecting rule stays
  // foot-only: it buys steadiness on a permanent glance surface, but on an
  // action surface it would swallow feedback from the buttons below.
  const connectionState = useLiveStatus((s) => s.connectionState);
  const stale = isStale(connectionState);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { orgs, error: discErr } = await discoverOrgsViaSidecar(key.trim());
      if (orgs.length === 0) {
        setError(
          discErr === "expired"
            ? "That session key looks invalid or expired."
            : "Couldn't reach Anthropic — check your connection and try again.",
        );
        return;
      }
      // orgs.length > 0 is proven by the guard above; orgs[0]! is safe.
      const pick =
        orgs.find((o) => o.capabilities.some((c) => SUBSCRIPTION_CAPS.includes(c))) ?? orgs[0]!;
      const cred = { sessionKey: key.trim(), orgId: pick.id };
      await writeCredential(cred);
      await pushCredentialToSidecar(cred);
      setKey("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await writeCredential(null);
      await pushCredentialToSidecar(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // The status line's three presentation pieces, resolved together so the dot,
  // the text colour, and the label can never disagree about whether we still
  // believe the mirror. `variant` is the glass `.dot` triad, which is what this
  // line has always drawn — `dotVariant` translates usage-status.ts' Tailwind
  // `bg-*` class into it, so the frozen constant's `variant` drops straight in.
  // Stale OUTRANKS `expired`, exactly as in the foot, and takes the deliberate
  // `expired` dot/text divergence (amber dot, red text — usage-status.ts:56-59)
  // with it; that divergence is untouched on the non-stale path.
  const line = stale
    ? {
        variant: STALE_USAGE_LINE.variant,
        textClass: STALE_USAGE_LINE.textClass,
        label: STALE_USAGE_LINE.title,
      }
    : {
        variant: dotVariant(usageConnectionDot(connection)),
        textClass: usageConnectionTextClass(connection),
        label: usageConnectionLabel(connection),
      };

  return (
    <>
      <div className="status-line">
        <span className={cn("dot", line.variant)} aria-hidden />
        <span className={line.textClass}>{line.label}</span>
        {/* Kept when stale, unlike the foot's relative "sampled Nm ago": an
            ABSOLUTE last-reading time is a fact about the past that a dropped
            channel doesn't invalidate, so it stays true beside "state unknown"
            — and it is the one thing on this line still worth knowing. */}
        {lastSampleAt !== null ? (
          <span className="when">— last reading {formatSampleTime(lastSampleAt, display)}</span>
        ) : null}
      </div>

      <div className="row-line">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Paste sessionKey cookie value"
          aria-label="claude.ai session key"
          className="input"
          // Allow pressing Enter to connect
          onKeyDown={(e) => {
            if (e.key === "Enter" && key.trim() !== "" && !busy) void connect();
          }}
        />
        <button
          type="button"
          className="chip"
          disabled={busy || key.trim() === ""}
          onClick={() => void connect()}
        >
          {busy ? "Connecting…" : "Connect"}
        </button>
        <button type="button" className="chip" disabled={busy} onClick={() => void disconnect()}>
          Disconnect
        </button>
      </div>

      {error !== null ? <p className="err">{error}</p> : null}

      <p className="helper">
        Shows real 5-hour and weekly subscription limits. The key is stored in the OS keychain and
        must be re-pasted when it expires (every few weeks). Find it in your browser&rsquo;s cookies
        for claude.ai under the name <code>sessionKey</code>.
      </p>
    </>
  );
}
