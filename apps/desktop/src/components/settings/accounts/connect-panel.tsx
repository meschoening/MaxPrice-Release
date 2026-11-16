import { useState } from "react";
import { CONNECT_COPY, type ConnectOrganizationView } from "@/lib/connect-flow";
import { UNREADABLE_PILL, UNREADABLE_TITLE, type MembershipRowView } from "@/lib/accounts-view";
import type { ConnectSuccess } from "@/state/use-connect-flow";
import { HomeBadge, Pill, SessionKeyText, TrackSwitch } from "./atoms";

// Settings › Accounts' Connect flow (#621's "The Connect flow"; ADR-0138
// §2–§4): its paste step and its result step, inline where it opened. The run
// and its state live in `useConnectFlow` (state/use-connect-flow.ts), so a
// card that regroups when Connect tracks its Account keeps its result; the
// page binds the run. Both steps are pure here.

export function ConnectPasteContent({
  lead,
  helper,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  lead: string;
  helper: string;
  busy: boolean;
  error: string | null;
  onSubmit: (sessionKey: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [key, setKey] = useState("");
  const ready = key.trim() !== "" && !busy;
  return (
    <div className="connect-flow">
      <p className="connect-lead">{lead}</p>
      <div className="row-line">
        <input
          type="password"
          className="input"
          autoFocus
          autoComplete="off"
          value={key}
          placeholder={CONNECT_COPY.placeholder}
          aria-label={CONNECT_COPY.inputLabel}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ready) onSubmit(key);
            if (e.key === "Escape" && !busy) onCancel();
          }}
        />
        <button type="button" className="chip" disabled={!ready} onClick={() => onSubmit(key)}>
          {busy ? CONNECT_COPY.checking : CONNECT_COPY.connect}
        </button>
        <button type="button" className="chip ghost-btn" disabled={busy} onClick={onCancel}>
          {CONNECT_COPY.cancel}
        </button>
      </div>
      {error !== null ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
      <p className="helper">
        <SessionKeyText text={helper} />
      </p>
    </div>
  );
}

// One of the key's Organizations in the result step, with its Track switch as
// the settings decide it now (it changes under the step as the user toggles).
export type ConnectResultOrganization = ConnectOrganizationView & {
  track: MembershipRowView["track"];
};

export function ConnectResultContent({
  result,
  organizations,
  onToggle,
  onDone,
}: {
  result: ConnectSuccess;
  organizations: readonly ConnectResultOrganization[];
  onToggle: (org: ConnectResultOrganization) => void;
  onDone: () => void;
}): React.ReactElement {
  return (
    <div className="connect-flow" role="status">
      <h3 className="connect-title">
        <span className="dot good" aria-hidden />
        {result.title}
      </h3>
      {result.mismatch !== null ? (
        <p className="connect-mismatch">
          <b>{result.mismatch.lead}</b> {result.mismatch.text}
        </p>
      ) : result.sentences.length > 0 ? (
        <p className="connect-lead">{result.sentences.join(" ")}</p>
      ) : null}
      <div className="connect-orgs-head">
        <b>{result.organizationsHeading}</b>
        <span>{result.organizationsNote}</span>
      </div>
      <ul className="acct-mems connect-orgs" aria-label={result.organizationsHeading}>
        {organizations.map((org) => (
          <li key={org.organizationUuid} className={org.track.on ? "acct-mem" : "acct-mem off"}>
            <span className="acct-org">
              <span className="acct-org-name static">{org.label}</span>
              {org.plan !== null && org.plan !== org.label ? (
                <span className="acct-fact">{org.plan}</span>
              ) : null}
              {org.isNew ? <Pill tone="new">New</Pill> : null}
            </span>
            <span className="acct-right">
              {org.readability === "unreadable" ? (
                <Pill tone="warn" title={UNREADABLE_TITLE}>
                  {UNREADABLE_PILL}
                </Pill>
              ) : null}
              {org.home ? <HomeBadge /> : null}
              <TrackSwitch
                on={org.track.on}
                canToggle={org.track.canToggle}
                title={org.track.title}
                label={`Track ${org.label}`}
                onToggle={() => onToggle(org)}
              />
            </span>
          </li>
        ))}
      </ul>
      <div className="connect-done">
        <button type="button" className="chip active" onClick={onDone}>
          {CONNECT_COPY.done}
        </button>
      </div>
    </div>
  );
}
