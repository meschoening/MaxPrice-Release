import { useEffect, useState } from "react";
import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import {
  checkLabel,
  hubAccountLabel,
  hubKeyHeld,
  hubKeyProvenance,
  hubKeyRow,
  LABEL_MAX,
  type HubAccount,
  type HubCredentialAck,
  type HubOrganization,
  type LabelEntry,
} from "@maxprice/shared";
import { LabelRenameFlow, type LabelRename } from "@/components/LabelRenameFlow";
import { useHubLabelDirectory } from "@/state/use-hub-label-directory";
import { useHubOrganizations } from "@/state/use-hub-organizations";
import { useHubStatus } from "@/state/use-hub-status";
import { useNowTick } from "@/state/use-now-tick";
import { useRenameAccount } from "@/state/use-account-mutations";
import { useRenameOrganization } from "@/state/use-organization-mutations";
import {
  clearCredential,
  hubLabelDirectoryQueryKey,
  hubOrganizationsQueryKey,
  hubStatusQueryKey,
  saveCredential,
} from "@/lib/hub-api";
import { dotVariant } from "@/lib/dot-variant";
import { showToast } from "@/lib/toast";
import {
  accountMembershipLines,
  accountNeedsKey,
  organizationLabelOf,
  accountState,
  accountsHead,
  membershipFold,
  organizationLabels,
  rankHubAccounts,
  type AccountMembershipLine,
} from "@/lib/presentation";

// The Accounts card (#614 §1–§5, ADR-0138 §9, ADR-0139 §1): every Account the
// Hub knows, keyed or not, each a row with its Memberships nested beneath,
// ranked by the one most used ordering. It replaces the Claude account card
// and the Organizations card once the Hub knows more than one Account or one
// Account's several Memberships (`todayAccountLook`). v7 carries one Provider
// (ADR-0136 §1), so one card, titled Accounts. The Hub never holds an email:
// an Account is its Label directory label, else `Account <first 8>`.

// How many Membership lines an Account shows before the rest fold (#614 §3).
export const MEMBERSHIPS_SHOWN = 3;

// What the card does, so the tests render it without a Hub. `saveKey` answers
// the Account the Hub filed the key under (ADR-0139 §4).
export type AccountsCardActions = {
  saveKey: (sessionKey: string) => Promise<HubCredentialAck>;
  removeKey: (accountUuid: string | null) => Promise<void>;
  renameAccount: LabelRename;
  renameOrganization: LabelRename;
};

// The card's rename for one Label directory kind: the Account's or the
// Organization's mutation, with its toast.
function labelRename(
  mutation: UseMutationResult<void, Error, { uuid: string; label: string | null }>,
  renamedToast: string,
): LabelRename {
  return {
    pending: mutation.isPending,
    error: mutation.isError ? mutation.error.message : null,
    submit: (uuid, label, done) =>
      mutation.mutate(
        { uuid, label },
        {
          onSuccess: () => {
            done();
            showToast(label === null ? "Label reset" : renamedToast);
          },
        },
      ),
    reset: mutation.reset,
  };
}

export function AccountsCard(): React.ReactElement {
  const qc = useQueryClient();
  const { data: status } = useHubStatus();
  const { data: organizations } = useHubOrganizations();
  const { data: labels } = useHubLabelDirectory();
  const now = useNowTick();
  const renameAccount = labelRename(useRenameAccount(), "Account renamed");
  const renameOrganization = labelRename(useRenameOrganization(), "Organization renamed");
  const refresh = async (): Promise<void> => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: hubStatusQueryKey() }),
      qc.invalidateQueries({ queryKey: hubOrganizationsQueryKey() }),
      qc.invalidateQueries({ queryKey: hubLabelDirectoryQueryKey() }),
    ]);
  };
  return (
    <AccountsCardContent
      accounts={status?.accounts ?? []}
      accountLabels={labels?.accounts}
      rows={organizations?.organizations}
      now={now}
      actions={{
        saveKey: async (sessionKey) => {
          const ack = await saveCredential(sessionKey);
          await refresh();
          return ack;
        },
        removeKey: async (accountUuid) => {
          await clearCredential(accountUuid);
          await refresh();
        },
        renameAccount,
        renameOrganization,
      }}
    />
  );
}

// One open flow at a time: an Account's menu, key paste or rename, the card
// foot's Add key, or a Membership line's menu or rename.
type Flow =
  | { kind: "menu" | "key" | "rename"; account: string }
  | { kind: "add" }
  | { kind: "org-menu" | "org-rename"; account: string; organization: string };

// An Account's row key; the unmoved legacy key has no uuid.
const rowKey = (account: HubAccount): string => account.accountUuid ?? "legacy";

export function AccountsCardContent({
  accounts,
  accountLabels,
  rows,
  now,
  actions,
  initialFlow = null,
}: {
  accounts: readonly HubAccount[];
  // The Label directory's Account labels, once read.
  accountLabels: Readonly<Record<string, LabelEntry>> | undefined;
  rows: readonly HubOrganization[] | undefined;
  now: number;
  actions: AccountsCardActions;
  // A flow open at first render, for the tests and the guide's frames.
  initialFlow?: Flow | null;
}): React.ReactElement {
  const [flow, setFlow] = useState<Flow | null>(initialFlow);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const menuOpen = flow?.kind === "menu" || flow?.kind === "org-menu";
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent): void => {
      if (e.target instanceof Element && e.target.closest(".kmenu, .kebab") !== null) return;
      setFlow(null);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [menuOpen]);

  const open = (next: Flow | null): void => {
    setFlow(next);
    setError(null);
    actions.renameAccount.reset();
    actions.renameOrganization.reset();
  };

  const [row] = hubKeyRow(accounts);
  const ranked = rankHubAccounts(accounts, accountLabels, now);
  const orgLabels = organizationLabels(rows ?? []);
  // An Account's Organizations by label, as the card's lines name them: what
  // Add key's answer lists once the Hub has read the key (#614 §4).
  const organizationsOf = (accountUuid: string): string[] =>
    (accounts.find((a) => a.accountUuid === accountUuid)?.memberships ?? []).map((m) =>
      organizationLabelOf(m.organizationUuid, orgLabels),
    );

  async function removeKey(account: HubAccount): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await actions.removeKey(account.accountUuid);
      setFlow(null);
      showToast("Key removed");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel card" aria-label="Accounts">
      <div className="card-head">
        <span className="eyebrow">Accounts</span>
        <span className="status">
          <span aria-hidden className={`dot ${dotVariant(row?.dot ?? null)}`} />
          {accountsHead(accounts)}
        </span>
      </div>
      <div>
        {ranked.map((account) => {
          const id = rowKey(account);
          const label = hubAccountLabel(account.accountUuid, accountLabels);
          const short = account.accountUuid?.slice(0, 8) ?? null;
          const state = accountState(account);
          const need = accountNeedsKey(account);
          const held = hubKeyHeld(account);
          const active = flow !== null && "account" in flow && flow.account === id ? flow : null;
          const lines = accountMembershipLines(account, orgLabels, now);
          const all = expanded.has(id);
          const shown = all ? lines : lines.slice(0, MEMBERSHIPS_SHOWN);
          const rest = lines.slice(MEMBERSHIPS_SHOWN);
          const entry =
            account.accountUuid === null ? undefined : accountLabels?.[account.accountUuid];
          return (
            <div key={id} className="mrow">
              <div className="mrow-top">
                <span aria-hidden className={`dot ${dotVariant(state.dot)}`} />
                <span className="mname">{label}</span>
                {short === null || label.includes(short) ? null : (
                  <span className="mid">{short}</span>
                )}
                <span className={need ? "mcount warn" : "mcount"}>{state.text}</span>
                {need ? (
                  <button
                    type="button"
                    className="chip active"
                    onClick={() => open({ kind: "key", account: id })}
                  >
                    {held ? "Replace key…" : "Add key…"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="chip kebab"
                  aria-label={`actions for ${label}`}
                  aria-haspopup="menu"
                  aria-expanded={active?.kind === "menu"}
                  onClick={() =>
                    open(active?.kind === "menu" ? null : { kind: "menu", account: id })
                  }
                >
                  ⋯
                </button>
              </div>
              <p className="msub">{held ? hubKeyProvenance(account, now) : "No key on this Hub"}</p>

              {active?.kind === "menu" ? (
                <div className="kmenu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => open({ kind: "key", account: id })}
                  >
                    {held ? "Replace key…" : "Add key…"}
                  </button>
                  {account.accountUuid === null ? null : (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => open({ kind: "rename", account: id })}
                    >
                      Rename…
                    </button>
                  )}
                  {held ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="danger"
                      disabled={busy}
                      onClick={() => void removeKey(account)}
                    >
                      Remove key
                    </button>
                  ) : null}
                </div>
              ) : null}

              {active?.kind === "key" ? (
                <KeyFlow
                  account={account}
                  accountLabels={accountLabels}
                  organizationsOf={organizationsOf}
                  actions={actions}
                  onClose={() => open(null)}
                />
              ) : null}

              {active?.kind === "rename" && account.accountUuid !== null ? (
                <LabelRenameFlow
                  uuid={account.accountUuid}
                  label={entry?.label ?? label}
                  renamed={(entry?.label ?? null) !== null}
                  noun="account"
                  rename={actions.renameAccount}
                  onClose={() => open(null)}
                />
              ) : null}

              {lines.length === 0 ? null : (
                <div className="anest">
                  {shown.map((line) => (
                    <MembershipLine
                      key={line.organizationUuid}
                      line={line}
                      row={rows?.find((r) => r.uuid === line.organizationUuid)}
                      flow={
                        active !== null &&
                        "organization" in active &&
                        active.organization === line.organizationUuid
                          ? active.kind
                          : null
                      }
                      onFlow={(kind) =>
                        open(
                          kind === null
                            ? null
                            : { kind, account: id, organization: line.organizationUuid },
                        )
                      }
                      rename={actions.renameOrganization}
                    />
                  ))}
                  {rest.length > 0 && !all ? (
                    <button
                      type="button"
                      className="amore"
                      onClick={() => setExpanded(new Set([...expanded, id]))}
                    >
                      {`${membershipFold(rest)} · Show all`}
                    </button>
                  ) : null}
                </div>
              )}
              {error !== null && active !== null ? <p className="err">{error}</p> : null}
            </div>
          );
        })}
      </div>

      {flow?.kind === "add" ? (
        <KeyFlow
          account={undefined}
          accountLabels={accountLabels}
          organizationsOf={organizationsOf}
          actions={actions}
          onClose={() => open(null)}
        />
      ) : (
        <div className="btnrow">
          <button type="button" className="chip" onClick={() => open({ kind: "add" })}>
            Add key…
          </button>
        </div>
      )}
      <p className="hint">
        One key per Account, write-only — stored in this machine&rsquo;s keychain and never shown.
        Labels are shared with every machine through the Label directory.
      </p>
    </section>
  );
}

// One Membership line (#614 §3): its Organization, its state, and a menu
// with Rename organization….
function MembershipLine({
  line,
  row,
  flow,
  onFlow,
  rename,
}: {
  line: AccountMembershipLine;
  // The roster's row, for the rename's bare label; missing when no key lists
  // it and no label names it.
  row: HubOrganization | undefined;
  flow: "org-menu" | "org-rename" | null;
  onFlow: (kind: "org-menu" | "org-rename" | null) => void;
  rename: LabelRename;
}): React.ReactElement {
  return (
    <div className="aline-wrap">
      <div className="aline">
        <span aria-hidden className={`dot ${dotVariant(line.state.dot)}`} />
        <span className="aname">{line.label}</span>
        <span className={line.state.stale ? "aval stale" : "aval"}>{line.state.text}</span>
        <button
          type="button"
          className="chip kebab"
          aria-label={`actions for ${line.label}`}
          aria-haspopup="menu"
          aria-expanded={flow === "org-menu"}
          onClick={() => onFlow(flow === "org-menu" ? null : "org-menu")}
        >
          ⋯
        </button>
      </div>
      {flow === "org-menu" ? (
        <div className="kmenu" role="menu">
          <button type="button" role="menuitem" onClick={() => onFlow("org-rename")}>
            Rename organization…
          </button>
        </div>
      ) : null}
      {flow === "org-rename" ? (
        <LabelRenameFlow
          uuid={line.organizationUuid}
          label={row?.label ?? line.label}
          renamed={row?.renamed ?? false}
          noun="organization"
          rename={rename}
          onClose={() => onFlow(null)}
        />
      ) : null}
    </div>
  );
}

// Add key… and Replace key… (#614 §2, §4; ADR-0138 §2, §9): paste the key,
// Save key; the Hub reads its Account from claude.ai and files the key there,
// replacing that Account's earlier key. The answer names the Account, and a
// new one is offered a label so every machine shows the same name.
function KeyFlow({
  account,
  accountLabels,
  organizationsOf,
  actions,
  onClose,
}: {
  // The row the paste was opened from; undefined from the card's foot.
  account: HubAccount | undefined;
  accountLabels: Readonly<Record<string, LabelEntry>> | undefined;
  organizationsOf: (accountUuid: string) => string[];
  actions: AccountsCardActions;
  onClose: () => void;
}): React.ReactElement {
  const [sessionKey, setSessionKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The Account the Hub filed the key under, once saved.
  const [saved, setSaved] = useState<string | null>(null);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const ack = await actions.saveKey(sessionKey.trim());
      setSessionKey("");
      // A fresh key for the row's own Account: done. Any other answer names
      // the Account the Hub filed it under and its Organizations (#614 §4).
      if (ack.accountUuid === account?.accountUuid) {
        showToast("Key saved");
        onClose();
        return;
      }
      setSaved(ack.accountUuid);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (saved !== null) {
    return (
      <AccountLabelOffer
        accountUuid={saved}
        label={accountLabels?.[saved]?.label ?? null}
        organizations={organizationsOf(saved)}
        other={account !== undefined}
        rename={actions.renameAccount}
        onClose={onClose}
      />
    );
  }
  return (
    <div className="flow mflow">
      <input
        className="input"
        type="password"
        value={sessionKey}
        onChange={(e) => setSessionKey(e.target.value)}
        placeholder="Paste a claude.ai sessionKey"
        aria-label="claude.ai session key"
      />
      <div className="btns">
        <button
          type="button"
          className="chip active"
          disabled={busy || sessionKey.trim() === ""}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save key"}
        </button>
        <button type="button" className="chip ghost-btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
      {error !== null ? <p className="err">{error}</p> : null}
    </div>
  );
}

// After Add key saves (#614 §4, ADR-0138 §9): the Account the Hub filed the
// key under, by its label or short id, and its Organizations; for an Account
// with no label yet, an optional label for every machine to show.
export function AccountLabelOffer({
  accountUuid,
  label,
  organizations,
  other,
  rename,
  onClose,
  initialDraft = "",
}: {
  accountUuid: string;
  // The Label directory's label for it, null when it has none.
  label: string | null;
  // The Account's Organizations by label, once the Hub has listed them.
  organizations: readonly string[];
  // The key was pasted on another Account's row.
  other: boolean;
  rename: LabelRename;
  onClose: () => void;
  // A draft at first render, for the tests.
  initialDraft?: string;
}): React.ReactElement {
  const [draft, setDraft] = useState(initialDraft);
  const check = checkLabel(draft);
  return (
    <div className="flow mflow">
      <p className="hint">
        {other
          ? "That key is for another Account, so it was saved there: "
          : "Saved. The key is for "}
        <b>{label ?? hubAccountLabel(accountUuid)}</b>
        {organizations.length === 0
          ? ""
          : `, with ${organizations.length === 1 ? "1 Organization" : `${organizations.length} Organizations`}: ${organizations.join(", ")}`}
        {label === null ? ". Name it so every machine shows the same label:" : "."}
      </p>
      {label !== null ? (
        <div className="btns">
          <button type="button" className="chip active" onClick={onClose}>
            Done
          </button>
        </div>
      ) : (
        <div className="btns">
          <input
            className="input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Label (optional)"
            aria-label="account label"
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="chip active"
            // An empty label is no label: Done just closes. A label past the
            // limit waits, as the rename inset's Save does.
            disabled={rename.pending || (!check.ok && check.reason === "too-long")}
            onClick={() => {
              if (check.ok) rename.submit(accountUuid, check.label, onClose);
              else onClose();
            }}
          >
            {rename.pending ? "Saving…" : "Done"}
          </button>
        </div>
      )}
      {!check.ok && check.reason === "too-long" ? (
        <p className="err">{`Use ${LABEL_MAX} characters or fewer.`}</p>
      ) : null}
      {rename.error !== null ? <p className="err">{rename.error}</p> : null}
    </div>
  );
}
