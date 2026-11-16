import { ChevronDown } from "lucide-react";
import type { HomeView, StripView } from "@/lib/accounts-view";
import { cn } from "@/lib/utils";

// The head of Settings › Accounts (#621): the attention strips, shown only
// when they apply (the expired legacy key, ADR-0138 §12; dead keys, §8; a
// hub-connected client, §7), and the Home membership select (ADR-0136 §5),
// hidden at one Account. Pure.

export function AccountStrips({
  strips,
  legacyFlow,
  sendKeysBusy,
  sendKeysError,
  onLegacyReconnect,
  onReconnect,
  onSendKeys,
}: {
  strips: readonly StripView[];
  // The Connect flow opened from the legacy strip, under it; else null.
  legacyFlow: React.ReactNode;
  sendKeysBusy: boolean;
  sendKeysError: string | null;
  onLegacyReconnect: () => void;
  // Open that Account's Connect.
  onReconnect: (accountKey: string) => void;
  onSendKeys: (next: boolean) => void;
}): React.ReactElement | null {
  if (strips.length === 0 && (legacyFlow === null || legacyFlow === undefined)) return null;
  return (
    <div className="acct-strips">
      {strips.map((strip) => {
        switch (strip.kind) {
          case "legacy":
            return (
              <div key="legacy" className="acct-strip-group">
                <div className="acct-strip warn" role="note">
                  <span>
                    <b>{strip.lead}</b> {strip.rest}
                  </span>
                  {legacyFlow ? null : (
                    <button type="button" className="chip warn" onClick={onLegacyReconnect}>
                      {strip.action}
                    </button>
                  )}
                </div>
                {legacyFlow ? <div className="acct-flow">{legacyFlow}</div> : null}
              </div>
            );
          case "reconnect":
            return (
              <div key="reconnect" className="acct-strip warn" role="note">
                <span>
                  <b>{strip.headline}:</b>{" "}
                  {strip.accounts.map((a, i) => (
                    <span key={a.key}>
                      {i > 0 ? ", " : ""}
                      <button
                        type="button"
                        className="acct-link"
                        onClick={() => onReconnect(a.key)}
                      >
                        {a.label}
                      </button>
                    </span>
                  ))}
                  . {strip.tail}
                </span>
              </div>
            );
          case "hub":
            return (
              <div key="hub" className="acct-strip-group">
                <div className="acct-strip" role="note">
                  <span>
                    {strip.lead}
                    <b>{strip.host}</b>
                    {strip.tail}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={strip.sendKeys.on}
                    disabled={sendKeysBusy}
                    title={strip.sendKeys.title}
                    className="toggle"
                    onClick={() => onSendKeys(!strip.sendKeys.on)}
                  >
                    {strip.sendKeys.label}
                    <span className="track" aria-hidden />
                  </button>
                </div>
                {sendKeysError !== null ? <p className="err">{sendKeysError}</p> : null}
              </div>
            );
        }
      })}
      {/* The legacy flow outlives its strip: the strip goes once the new key
          replaces the legacy one, while the result step still shows. */}
      {legacyFlow && !strips.some((s) => s.kind === "legacy") ? (
        <div className="acct-flow">{legacyFlow}</div>
      ) : null}
    </div>
  );
}

// The option values pair the Organization and the Account.
function optionValue(o: { organizationUuid: string; accountUuid: string | null }): string {
  return `${o.organizationUuid}|${o.accountUuid ?? ""}`;
}

export function HomeMembershipSelects({
  home,
  onPick,
}: {
  home: HomeView;
  onPick: (organizationUuid: string, accountUuid: string) => void;
}): React.ReactElement {
  return (
    <>
      {home.selects.map((select) => {
        const chosen = select.options.find((o) => o.selected);
        return (
          <div key={select.provider} className="row-line acct-home-row">
            {select.showMark ? (
              <span className={cn("acct-mark", select.provider)} title={select.providerName}>
                {select.providerName[0]}
              </span>
            ) : null}
            <div className="select-wrap acct-home-select">
              <select
                className="input"
                aria-label={
                  select.showMark ? `${select.providerName} Home membership` : "Home membership"
                }
                value={chosen === undefined ? "" : optionValue(chosen)}
                onChange={(e) => {
                  const [organizationUuid, accountUuid] = e.target.value.split("|");
                  if (organizationUuid && accountUuid) onPick(organizationUuid, accountUuid);
                }}
              >
                {chosen === undefined ? <option value="">Choose a Membership…</option> : null}
                {select.options.map((o) => (
                  <option key={optionValue(o)} value={optionValue(o)}>
                    {o.label}
                  </option>
                ))}
              </select>
              <ChevronDown aria-hidden />
            </div>
          </div>
        );
      })}
    </>
  );
}
