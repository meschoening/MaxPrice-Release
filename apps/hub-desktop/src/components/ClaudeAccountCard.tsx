import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  formatRelativeTime,
  usageConnectionDot,
  usageConnectionLabel,
  type HubOrganization,
  type UsageConnection,
} from "@maxprice/shared";
import { useHubOrganizations } from "@/state/use-hub-organizations";
import { useHubStatus } from "@/state/use-hub-status";
import { useNowTick } from "@/state/use-now-tick";
import { hubFetch, hubStatusQueryKey } from "@/lib/hub-api";
import { dotVariant } from "@/lib/dot-variant";
import { showToast } from "@/lib/toast";
import {
  accountOrganizationValue,
  discoveredOrganizations,
  formatProvenance,
  organizationLabels,
} from "@/lib/presentation";

export function ClaudeAccountCard(): React.ReactElement {
  const { data: status } = useHubStatus();
  const { data: organizations } = useHubOrganizations();
  const qc = useQueryClient();
  const now = useNowTick();
  const [editing, setEditing] = useState(false);
  const [sessionKey, setSessionKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const conn = status?.usageConnection ?? "disconnected";
  const present = status?.credentialPresent ?? false;

  async function postCredential(body: unknown): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await hubFetch("/api/credential", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`credential ${res.status}: ${await res.text()}`);
      setSessionKey("");
      setEditing(false);
      await qc.invalidateQueries({ queryKey: hubStatusQueryKey() });
      showToast(body === null ? "Key cleared" : "Key saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel card" aria-label="Claude account">
      <div className="card-head">
        <span className="eyebrow">Claude account</span>
        <span className="status">
          <span aria-hidden className={`dot ${dotVariant(usageConnectionDot(conn))}`} />
          {usageConnectionLabel(conn)}
        </span>
      </div>
      <div className="krows">
        <div className="krow">
          <span>Last sample</span>
          <b>{formatRelativeTime(status?.usageLastSampleAt ?? null, now)}</b>
        </div>
        <AccountOrganizationRow rows={organizations?.organizations} connection={conn} />
        <div className="krow">
          <span>Key</span>
          <b>
            {present
              ? formatProvenance(status?.credentialUpdatedAt, status?.credentialSource, now)
              : "No key set"}
          </b>
        </div>
      </div>

      {editing ? (
        <div className="flow">
          <input
            className="input"
            type="password"
            value={sessionKey}
            onChange={(e) => setSessionKey(e.target.value)}
            placeholder="Paste sessionKey cookie value"
            aria-label="claude.ai session key"
          />
          <div className="btns">
            <button
              type="button"
              className="chip active"
              disabled={busy || sessionKey.trim() === ""}
              // The key alone (ADR-0104): the Hub lists and polls every
              // Organization it can read.
              onClick={() => void postCredential({ sessionKey: sessionKey.trim() })}
            >
              {busy ? "Saving…" : "Save key"}
            </button>
            <button
              type="button"
              className="chip ghost-btn"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setError(null);
                setSessionKey("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="btnrow">
          <button type="button" className="chip" onClick={() => setEditing(true)}>
            Replace key…
          </button>
          <button
            type="button"
            className="chip ghost-btn"
            disabled={busy || !present}
            onClick={() => void postCredential(null)}
          >
            Clear
          </button>
        </div>
      )}

      {error !== null ? <p className="err">{error}</p> : null}
      <p className="hint">
        The key is write-only — stored in this machine&rsquo;s keychain and never shown. Paste a
        fresh <code>sessionKey</code> when claude.ai reports the session expired.
      </p>
    </section>
  );
}

// The Organization row (#294): what the key discovered, by label. The labels
// span every row the roster answers, so a collision suffix here reads as it
// does on the Organizations card and the Machines card's Home lines.
export function AccountOrganizationRow({
  rows,
  connection,
}: {
  rows: readonly HubOrganization[] | undefined;
  connection: UsageConnection;
}): React.ReactElement {
  return (
    <div className="krow">
      <span>Organization</span>
      <b>
        {accountOrganizationValue(
          discoveredOrganizations(rows, connection),
          organizationLabels(rows ?? []),
        )}
      </b>
    </div>
  );
}
