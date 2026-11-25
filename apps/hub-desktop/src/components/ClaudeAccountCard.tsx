import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  formatRelativeTime,
  hubKeyHeld,
  hubLastReadAt,
  hubKeyProvenance,
  usageConnectionDot,
  usageConnectionLabel,
  type HubAccount,
  type HubOrganization,
} from "@maxprice/shared";
import { useHubOrganizations } from "@/state/use-hub-organizations";
import { useHubStatus } from "@/state/use-hub-status";
import { useNowTick } from "@/state/use-now-tick";
import { clearCredential, hubStatusQueryKey, saveCredential } from "@/lib/hub-api";
import { dotVariant } from "@/lib/dot-variant";
import { showToast } from "@/lib/toast";
import { accountOrganizationValue, keyOrganizations, organizationLabels } from "@/lib/presentation";

// The Claude account card (ADR-0036, ADR-0139 §4) at today's look: kept for a
// Hub that knows no Account yet and for a single Account with at most one
// Membership (#614 §7, `todayAccountLook`); anything more gets the Accounts
// card. Save posts the key alone to /api/credentials, where the Hub learns its
// Account; Clear removes the key by its own route.
export function ClaudeAccountCard(): React.ReactElement {
  const { data: status } = useHubStatus();
  const { data: organizations } = useHubOrganizations();
  const now = useNowTick();
  return (
    <ClaudeAccountCardContent
      account={status?.accounts[0]}
      rows={organizations?.organizations}
      lastReadAt={hubLastReadAt(status?.accounts ?? [])}
      now={now}
    />
  );
}

// Props only, so the tests render it without a Hub. An Account the fleet
// names only by an event tag holds no key, so the card reads as no key.
export function ClaudeAccountCardContent({
  account,
  rows,
  lastReadAt,
  now,
}: {
  // The Hub's one Account, undefined while it knows none.
  account: HubAccount | undefined;
  rows: readonly HubOrganization[] | undefined;
  lastReadAt: string | null;
  now: number;
}): React.ReactElement {
  const entry = account !== undefined && hubKeyHeld(account) ? account : undefined;
  return <AccountCard entry={entry} rows={rows} lastReadAt={lastReadAt} now={now} />;
}

function AccountCard({
  entry,
  rows,
  lastReadAt,
  now,
}: {
  // The held key this card shows; undefined: no key at all.
  entry: HubAccount | undefined;
  rows: readonly HubOrganization[] | undefined;
  lastReadAt: string | null;
  now: number;
}): React.ReactElement {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [sessionKey, setSessionKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const conn = entry?.connection ?? "disconnected";
  const heading = "Claude account";

  async function act(request: () => Promise<unknown>, done: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await request();
      setSessionKey("");
      setEditing(false);
      await qc.invalidateQueries({ queryKey: hubStatusQueryKey() });
      showToast(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel card" aria-label={heading}>
      <div className="card-head">
        <span className="eyebrow">{heading}</span>
        <span className="status">
          <span aria-hidden className={`dot ${dotVariant(usageConnectionDot(conn))}`} />
          {usageConnectionLabel(conn)}
        </span>
      </div>
      <div className="krows">
        <div className="krow">
          <span>Last read</span>
          <b>{formatRelativeTime(lastReadAt, now)}</b>
        </div>
        <AccountOrganizationRow rows={rows} entry={entry} />
        <div className="krow">
          <span>Key</span>
          <b>{hubKeyProvenance(entry, now)}</b>
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
              // The key alone (ADR-0139 §4): the Hub reads its Account from
              // claude.ai, stores it there, and lists and polls every
              // Organization that Account can read.
              onClick={() => void act(() => saveCredential(sessionKey.trim()), "Key saved")}
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
            disabled={busy || entry === undefined}
            onClick={() => {
              if (entry !== undefined)
                void act(() => clearCredential(entry.accountUuid), "Key cleared");
            }}
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

// The Organization row (#294): what this card's key discovered, by label. The
// labels span every row the roster answers, so a collision suffix here reads
// as it does on the Accounts card and the Machines card's Home lines.
export function AccountOrganizationRow({
  rows,
  entry,
}: {
  rows: readonly HubOrganization[] | undefined;
  entry: HubAccount | undefined;
}): React.ReactElement {
  return (
    <div className="krow">
      <span>Organization</span>
      <b>
        {accountOrganizationValue(
          entry === undefined ? [] : keyOrganizations(rows, entry),
          organizationLabels(rows ?? []),
        )}
      </b>
    </div>
  );
}
