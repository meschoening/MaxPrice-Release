import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isValidHubPassword } from "@maxprice/shared";
import { useHubStatus } from "@/state/use-hub-status";
import { hubFetch, hubStatusQueryKey } from "@/lib/hub-api";
import { dotVariant } from "@/lib/dot-variant";
import { accessDot, accessLabel } from "@/lib/presentation";
import { showToast } from "@/lib/toast";

// Hub password card (ADR-0037): set / replace / clear the optional password
// gating fleet clients. The console itself authenticates with the per-launch
// operator secret, so it keeps working whatever the password state — including
// recovering from a forgotten password. Write-only: never echoed back.

export function AccessCard(): React.ReactElement {
  const { data: status } = useHubStatus();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isProtected = status?.passwordProtected ?? false;

  async function postPassword(value: string | null): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await hubFetch("/api/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: value }),
      });
      if (!res.ok) throw new Error(`password ${res.status}: ${await res.text()}`);
      setPassword("");
      setEditing(false);
      await qc.invalidateQueries({ queryKey: hubStatusQueryKey() });
      showToast(value === null ? "Password cleared" : "Password set");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const trimmed = password.trim();

  return (
    <section className="panel card" aria-label="Access">
      <div className="card-head">
        <span className="eyebrow">Access</span>
        <span className="status">
          {/* Vocabulary lives in presentation.ts (ADR-0050): the popout's
              Access row consumes the same source, so the words can't drift. */}
          <span aria-hidden className={`dot ${dotVariant(accessDot(isProtected))}`} />
          {accessLabel(isProtected)}
        </span>
      </div>

      {editing ? (
        <div className="flow">
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="New hub password"
            aria-label="hub password"
            onKeyDown={(e) => {
              if (e.key === "Enter" && isValidHubPassword(trimmed) && !busy) {
                void postPassword(trimmed);
              }
            }}
          />
          <div className="btns">
            <button
              type="button"
              className="chip active"
              disabled={busy || !isValidHubPassword(trimmed)}
              onClick={() => void postPassword(trimmed)}
            >
              {busy ? "Saving…" : "Save password"}
            </button>
            <button
              type="button"
              className="chip ghost-btn"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setError(null);
                setPassword("");
              }}
            >
              Cancel
            </button>
          </div>
          {trimmed !== "" && !isValidHubPassword(trimmed) ? (
            <p className="err">Printable ASCII, no spaces, max 128 characters.</p>
          ) : null}
        </div>
      ) : (
        <div className="btnrow">
          <button type="button" className="chip" onClick={() => setEditing(true)}>
            {isProtected ? "Replace password…" : "Set password…"}
          </button>
          <button
            type="button"
            className="chip ghost-btn"
            disabled={busy || !isProtected}
            title={isProtected ? undefined : "No password to clear"}
            onClick={() => void postPassword(null)}
          >
            Clear
          </button>
        </div>
      )}

      {error !== null ? <p className="err">{error}</p> : null}
      {!isProtected ? (
        <p className="hint">
          Without a password, any device on your tailnet can read usage data and change hub settings
          (the claude.ai key and this password). Set one to restrict writes.
        </p>
      ) : null}
      <p className="hint">
        Clients enter this password in the app&rsquo;s Settings. Leave it unset to allow any machine
        on your tailnet. This console always has access, password or not.
      </p>
    </section>
  );
}
