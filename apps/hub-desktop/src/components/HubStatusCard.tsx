import { Row } from "@/components/Rows";
import { useAutostart } from "@/state/use-autostart";
import { useFirewallCheck, useFirewallFix } from "@/state/use-firewall";
import { useHubStatus } from "@/state/use-hub-status";
import { useHubUrl } from "@/state/use-hub-url";
import { useCompactStore } from "@/state/use-machine-mutations";
import { useNowTick } from "@/state/use-now-tick";
import { formatRelativeTime } from "@maxprice/shared";
import { formatUptime } from "@/lib/relative-time";
import { dotVariant } from "@/lib/dot-variant";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  autostartRow,
  eventsDown,
  formatBytes,
  formatCount,
  formatListening,
  hubDaemonDot,
  hubDaemonLabel,
  hubDaemonState,
  hygieneState,
  isDeliberateLoopback,
  showFirewallWarning,
} from "@/lib/presentation";

export function HubStatusCard(): React.ReactElement {
  const { data: status, isError, isPending } = useHubStatus();
  const { data: hubUrl } = useHubUrl();
  const { data: firewall } = useFirewallCheck();
  const { data: autostart } = useAutostart();
  const fix = useFirewallFix();
  const compact = useCompactStore();
  const now = useNowTick();

  // The chip reports the DAEMON — reachable, serving the network, serving
  // event sync (ADR-0049). claude.ai health belongs to the Claude account card
  // alone; this card used to duplicate it.
  const daemon = hubDaemonState(isError, status, firewall);
  // Real daemon uptime from the contract's `startedAt` (string | null,
  // optional). Parse to ms at the call site; null/absent → em dash.
  const startedAt = status?.startedAt ?? null;
  const uptime = startedAt !== null ? formatUptime(Date.parse(startedAt), now) : "—";
  // Pending reads as "unsupported" ⇒ no row, rather than a row that flickers
  // through a wrong answer on the way to the right one.
  const login = autostartRow(autostart ?? "unsupported");

  return (
    <section className="panel card" aria-label="Hub status">
      <div className="card-head">
        <span className="eyebrow">Hub status</span>
        <span className="status">
          <span
            aria-hidden
            className={`dot ${dotVariant(hubDaemonDot(daemon, isDeliberateLoopback(status)))}`}
          />
          {hubDaemonLabel(daemon)}
        </span>
      </div>
      <div className="krows">
        <Row
          label="Listening"
          value={formatListening(status?.bindHosts, hubUrl)}
          title="The client-facing tailnet address — what other machines type into Settings"
        />
        <Row label="Uptime" value={uptime} />
        {/* Does the always-on hub actually survive a reboot (ADR-0051)? Read
            from the host's own registry, not the daemon — and read-only: the
            one "no" the operator can act on is their own Task Manager opt-out,
            which this app now honours instead of silently overriding. Absent
            entirely off Windows, where we manage no login entry. */}
        {login !== null ? (
          <Row
            label="Starts at login"
            value={login.value}
            warn={login.warn}
            title="Whether this installed app is registered to launch when you log in"
          />
        ) : null}
        {/* Named for the archive, not the poll (ADR-0049): this pair and the
            Fleet events pair below are the daemon's two stores and when each
            last grew. The Claude account card carries Last sample too, as key
            freshness — one duplicated number, two honest meanings. */}
        <Row
          label="Usage samples"
          value={status !== undefined ? formatCount(status.sampleCount) : "—"}
        />
        <Row
          label="Last sample"
          value={isPending ? "…" : formatRelativeTime(status?.usageLastSampleAt ?? null, now)}
        />
        {status?.events !== undefined ? (
          <>
            <Row
              label="Fleet events"
              value={`${formatCount(status.events.eventCount ?? 0)} · ${formatBytes(status.events.fileBytes ?? 0)}`}
            />
            <Row
              label="Last event"
              value={formatRelativeTime(status.events.lastAppendAt ?? null, now)}
            />
          </>
        ) : null}
      </div>
      {/* The bind resolution's own diagnosis, rendered verbatim (ADR-0049) —
          "no tailnet interface found" (the hub wanted the tailnet and bound
          loopback) or "you bound a public address" (serving, but in the
          clear). Absent on a clean resolve, INCLUDING a deliberate `bind:
          "loopback"`, which is why that hub's chip stays calm grey. */}
      {(status?.bindWarning ?? null) !== null ? (
        <div className="inset warn" role="note">
          <p className="lead">{status?.bindWarning}</p>
        </div>
      ) : null}
      {/* Reachable but half-serving (ADR-0049): the archive failed to load at
          boot, so the daemon kept polling while event sync is refused — the
          /api/events push+pull routes and the M7 mutations (rename / merge /
          purge / compact) all answer 503, and since the failed load is also why
          `events` never got patched onto this status, a capability-aware client
          doesn't even try. Only a restart clears it — index.ts loads the
          archive once. Same rule as the chip's `events-down` state, though the
          two need not agree: insets stack independently of chip precedence. */}
      {eventsDown(status) ? (
        <div className="inset warn" role="alert">
          <p className="lead">
            Fleet event archive failed to load — clients can&rsquo;t push events. Restart the hub.
          </p>
        </div>
      ) : null}
      {status?.events !== undefined && hygieneState(status.events) !== "clean" ? (
        <div
          className={cn("inset centered", hygieneState(status.events) === "unreadable" && "warn")}
          role="note"
        >
          {(status.events.unreadableLines ?? 0) > 0 ? (
            <p className="lead">
              {formatCount(status.events.unreadableLines ?? 0)} unreadable line(s) in the archive —
              those events were acked and are lost.
            </p>
          ) : null}
          {(status.events.garbageLines ?? 0) > 0 ? (
            <p>
              {formatCount(status.events.garbageLines ?? 0)} stale line(s) from replaced events
              {status.events.reclaimableBytes !== undefined
                ? ` · ${formatBytes(status.events.reclaimableBytes)}`
                : "."}
            </p>
          ) : null}
          {(status.events.garbageLines ?? 0) > 0 ? (
            <div className="btns">
              <button
                type="button"
                className="chip"
                disabled={compact.isPending}
                onClick={() =>
                  compact.mutate(undefined, { onSuccess: () => showToast("Archive compacted") })
                }
              >
                {compact.isPending ? "Compacting…" : "Compact now"}
              </button>
            </div>
          ) : null}
          {compact.isError ? <p className="err">{compact.error.message}</p> : null}
        </div>
      ) : null}
      {showFirewallWarning(status?.bindHosts, firewall) ? (
        <div className="inset centered warn" role="alert">
          <p className="lead">
            Windows Firewall is blocking tailnet connections — other machines can&rsquo;t reach this
            hub.
          </p>
          <div className="btns">
            <button
              type="button"
              className="chip"
              disabled={fix.isPending}
              onClick={() =>
                fix.mutate(undefined, {
                  onSuccess: (result) => {
                    if (result === "applied") showToast("Firewall rule added");
                  },
                })
              }
            >
              {fix.isPending ? "Waiting for approval…" : "Allow through firewall…"}
            </button>
          </div>
          {fix.isError ? <p className="err">{fix.error.message}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
