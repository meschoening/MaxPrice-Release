import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { formatRelativeTime, usageConnectionDot, usageConnectionLabel } from "@maxprice/shared";
import { useHubStatus } from "@/state/use-hub-status";
import { useNowTick } from "@/state/use-now-tick";
import { hubFetch, hubStatusQueryKey } from "@/lib/hub-api";
import { dotVariant } from "@/lib/dot-variant";
import { showToast } from "@/lib/toast";
import { formatProvenance } from "@/lib/presentation";

export function ClaudeAccountCard(): React.ReactElement {
  const { data: status } = useHubStatus();
  const qc = useQueryClient();
  const now = useNowTick();
  const [editing, setEditing] = useState(false);
  const [sessionKey, setSessionKey] = useState("");
  const [orgId, setOrgId] = useState("");
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
      setOrgId("");
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
        <div className="krow">
          <span>Organization</span>
          <b>{status?.orgId ?? "—"}</b>
        </div>
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
          <input
            className="input"
            type="text"
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
            placeholder="Organization id (orgId)"
            aria-label="organization id"
          />
          <div className="btns">
            <button
              type="button"
              className="chip active"
              disabled={busy || sessionKey.trim() === "" || orgId.trim() === ""}
              onClick={() =>
                void postCredential({ sessionKey: sessionKey.trim(), orgId: orgId.trim() })
              }
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
                setOrgId("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="btnrow">
          <button
            type="button"
            className="chip"
            onClick={() => {
              // Prefill the org from the contract so the operator usually
              // just pastes a new session key (the form still POSTs both).
              setOrgId(status?.orgId ?? "");
              setEditing(true);
            }}
          >
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
