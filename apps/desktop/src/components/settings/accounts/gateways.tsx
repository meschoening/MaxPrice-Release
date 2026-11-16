import { useState } from "react";
import { GATEWAYS_SECTION, type GatewaysView } from "@/lib/accounts-view";
import type { GatewayConnectOutcome } from "@/lib/gateway-connect";
import { Section } from "../settings-section";
import { ConnectionState } from "./atoms";

// Settings › Accounts › Gateways (ADR-0141 §7, §8; #639): one row per Gateway
// this machine holds (its state, the age of its last record, who drains it,
// the Accounts its credential list names) with Remove, and "Connect a
// Gateway", which opens the form in place. A Gateway has equal standing with
// logging in directly: this subsection sits beside the Provider's cards, not
// under them. Pure: the page binds the check and the store.

export function GatewaysSection({
  view,
  hubHost,
  formOpen,
  notes,
  removing,
  onOpenForm,
  onCloseForm,
  onConnect,
  onRemove,
}: {
  view: GatewaysView;
  // The joined Hub's host, for the send-up's words; null with no Hub.
  hubHost: string | null;
  formOpen: boolean;
  // A Remove's note, by Gateway id.
  notes: Readonly<Record<string, string>>;
  // The Gateway whose Remove is out.
  removing: string | null;
  onOpenForm: () => void;
  onCloseForm: () => void;
  onConnect: (url: string, managementKey: string) => Promise<GatewayConnectOutcome>;
  onRemove: (id: string) => void;
}): React.ReactElement {
  return (
    <Section
      title={view.title}
      description={GATEWAYS_SECTION.description}
      action={
        <button type="button" className="chip" disabled={formOpen} onClick={onOpenForm}>
          {view.connect}
        </button>
      }
    >
      {formOpen ? (
        <div className="acct-flow">
          <GatewayConnectForm hubHost={hubHost} onConnect={onConnect} onClose={onCloseForm} />
        </div>
      ) : null}
      {view.rows.length > 0 ? (
        <ul className="gw-rows" aria-label="Gateways">
          {view.rows.map((row) => (
            <li key={row.id} className="gw-row">
              <div className="gw-main">
                <span className="gw-host">{row.host}</span>
                <span className="gw-meta">
                  <ConnectionState text={row.stateText} tone={row.tone} />
                  {row.lastRecord !== null ? <span>{row.lastRecord}</span> : null}
                  {row.drainedByHub !== null ? <span>{row.drainedByHub}</span> : null}
                </span>
                {row.accounts.length > 0 ? (
                  <span className="gw-accounts">Holds {row.accounts.join(", ")}</span>
                ) : null}
              </div>
              <button
                type="button"
                className="chip"
                disabled={removing === row.id}
                onClick={() => onRemove(row.id)}
              >
                {view.remove}
              </button>
            </li>
          ))}
        </ul>
      ) : formOpen ? null : (
        <p className="hint-line">No Gateway is connected on this machine.</p>
      )}
      {/* Beside the rows, not in one: the removed Gateway's row goes at the
          refetch, and its note must outlive it. */}
      {Object.entries(notes).map(([id, note]) => (
        <p key={id} className="acct-note" role="status">
          {note}
        </p>
      ))}
    </Section>
  );
}

// The form: the Gateway's URL and its management key (a password field), then
// either the failure in words, or the connected step with both warnings.
export function GatewayConnectForm({
  hubHost,
  onConnect,
  onClose,
  initial,
}: {
  hubHost: string | null;
  onConnect: (url: string, managementKey: string) => Promise<GatewayConnectOutcome>;
  onClose: () => void;
  // Seeds the outcome for static rendering.
  initial?: GatewayConnectOutcome;
}): React.ReactElement {
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<GatewayConnectOutcome | null>(initial ?? null);

  if (outcome?.ok) {
    return (
      <div className="connect-flow" role="status">
        <h3 className="connect-title">
          <span className="dot good" aria-hidden />
          {GATEWAYS_SECTION.connected(outcome.host)}
        </h3>
        <div className="inset warn gw-warnings">
          {outcome.warnings.map((w) => (
            <p key={w} className="lead">
              {w}
            </p>
          ))}
        </div>
        <p className="connect-lead">{GATEWAYS_SECTION.tracksNothing}</p>
        <div className="connect-done">
          <button type="button" className="chip active" onClick={onClose}>
            {GATEWAYS_SECTION.done}
          </button>
        </div>
      </div>
    );
  }

  const ready = url.trim() !== "" && key.trim() !== "" && !busy;
  const submit = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true);
    setOutcome(await onConnect(url, key));
    setBusy(false);
  };
  return (
    <div className="connect-flow">
      <input
        type="text"
        className="input"
        autoFocus
        spellCheck={false}
        value={url}
        placeholder={GATEWAYS_SECTION.urlPlaceholder}
        aria-label={GATEWAYS_SECTION.urlLabel}
        onChange={(e) => setUrl(e.target.value)}
      />
      <div className="row-line">
        <input
          type="password"
          className="input"
          autoComplete="off"
          value={key}
          placeholder={GATEWAYS_SECTION.keyPlaceholder}
          aria-label={GATEWAYS_SECTION.keyLabel}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        <button type="button" className="chip" disabled={!ready} onClick={() => void submit()}>
          {busy ? GATEWAYS_SECTION.checking : GATEWAYS_SECTION.submit}
        </button>
        <button type="button" className="chip ghost-btn" disabled={busy} onClick={onClose}>
          {GATEWAYS_SECTION.cancel}
        </button>
      </div>
      {outcome !== null && !outcome.ok ? (
        <p className="err" role="alert">
          {outcome.error}
        </p>
      ) : null}
      <p className="helper">
        {GATEWAYS_SECTION.helper}
        {hubHost !== null ? ` ${GATEWAYS_SECTION.hubHelper(hubHost)}` : ""}
      </p>
    </div>
  );
}
