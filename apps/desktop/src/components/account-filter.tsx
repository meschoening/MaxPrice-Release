import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronDown, ChevronRight, Search, UserRound } from "lucide-react";
import { accountFilterVisible, formatCost, usageTone, type ScopeSetting } from "@maxprice/shared";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  accountMenuModel,
  clearScope,
  foldLine,
  matchAccount,
  MENU_FOLD_AFTER,
  MENU_TOP,
  onlyScope,
  PROVIDER_NAMES,
  rankAccounts,
  readoutLine,
  toggleScope,
  triggerSummary,
  usageText,
  type AccountMenuModel,
  type MenuAccount,
  type MenuMembership,
  type MenuOrder,
  type ProviderId,
} from "@/lib/account-menu";
import { nextOptionIndex } from "@/lib/option-keys";
import { cn } from "@/lib/utils";
import { useFilters } from "@/state/filters";
import { useMachineAxis } from "@/state/use-machine-axis";
import { useMembershipTotals } from "@/state/use-membership-totals";
import { useNowTick } from "@/state/use-now-tick";
import { useAccounts, useOrganizationLabels } from "@/state/use-organizations";
import { useProjectAxis } from "@/state/use-project-axis";
import { useSettings, useUpdateSettings } from "@/state/use-settings";
import { SETTINGS_ACCOUNTS_ANCHOR } from "@/lib/connect-flow";

// The rail's Provider switch and Account filter (#613 §3, #620 items 1–8,
// #637): a ranked menu of the tracked Accounts, each with its Memberships
// nested, that writes the Scope (`settings.scope`). Shown only once two
// Accounts are tracked (`accountFilterVisible`). The model and every rule are
// `lib/account-menu.ts`; the pieces here render it.

export type ProviderChoice = "all" | ProviderId;

// "All / Claude / ChatGPT" above the Account menu, only when the tracked
// Accounts span two Providers (#613 §3, #620 item 8). Never rendered in the
// product yet: every Account is Anthropic's (`providerOf`).
export function ProviderSwitch({
  providers,
  value,
  onChange,
}: {
  providers: readonly ProviderId[];
  value: ProviderChoice;
  onChange: (p: ProviderChoice) => void;
}): React.ReactElement | null {
  if (providers.length < 2) return null;
  return (
    <div className="field">
      <span className="eyebrow">Provider</span>
      <div className="presets seg" role="group" aria-label="Provider">
        {(["all", ...providers] as const).map((p) => (
          <button
            key={p}
            type="button"
            className={cn(value === p && "active")}
            aria-pressed={value === p}
            onClick={() => onChange(p)}
          >
            {p === "all" ? "All" : PROVIDER_NAMES[p]}
          </button>
        ))}
      </div>
    </div>
  );
}

function Box(): React.ReactElement {
  return (
    <span className="box" aria-hidden>
      <Check strokeWidth={3.5} />
    </span>
  );
}

export function AccountAvatar({ account }: { account: MenuAccount }): React.ReactElement {
  if (account.unknown) {
    // [proposed, #637] No Account, so no letter: a neutral mark.
    return (
      <span className="am-av unknown" aria-hidden>
        <UserRound />
      </span>
    );
  }
  if (account.pending) {
    return (
      <span className="am-av pending" aria-hidden title="Pending account: known by email only">
        @
      </span>
    );
  }
  return (
    <span className="am-av" aria-hidden>
      {account.mark}
    </span>
  );
}

interface RowHandlers {
  onToggle: (tokens: readonly string[]) => void;
  onOnly: (tokens: readonly string[]) => void;
}

function MembershipRow({ m, ...h }: { m: MenuMembership } & RowHandlers): React.ReactElement {
  return (
    <div className={cn("opt am-row am-nested", m.selected && "checked")}>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={m.selected}
        data-account-option
        className="am-hit"
        onClick={() => h.onToggle([m.token])}
      >
        <Box />
        <span className="am-name">
          <span>{m.label}</span>
        </span>
        {m.home ? <em>⌂ Home</em> : null}
      </button>
      <span className="am-metrics">
        <b className="num">{formatCost(m.costUSD)}</b>
      </span>
      <button
        type="button"
        className="am-only"
        aria-label={`Only ${m.label}`}
        onClick={() => h.onOnly([m.token])}
      >
        only
      </button>
    </div>
  );
}

function AccountRow({
  account,
  order,
  open,
  shown,
  onOpen,
  ...h
}: {
  account: MenuAccount;
  order: MenuOrder;
  open: boolean;
  // While searching, the Memberships an Organization match opened.
  shown: ReadonlySet<string> | undefined;
  onOpen: () => void;
} & RowHandlers): React.ReactElement {
  const tokens = account.memberships.map((m) => m.token);
  const on = account.memberships.filter((m) => m.selected).length;
  const all = on > 0 && on === account.memberships.length;
  const partial = on > 0 && !all;
  const several = account.memberships.length > 1;
  const tone = usageTone(account.usePct);
  const nested =
    shown && shown.size > 0
      ? account.memberships.filter((m) => shown.has(m.token))
      : account.memberships;
  return (
    <div className="am-acct">
      <div className={cn("opt am-row", all && "checked", partial && "half")}>
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={all ? true : partial ? "mixed" : false}
          data-account-option
          className="am-hit"
          onClick={() => h.onToggle(tokens)}
        >
          <Box />
          <AccountAvatar account={account} />
          <span className="am-name">
            <b>{account.label}</b>
            {account.sub !== null ? <span className="am-sub">{account.sub}</span> : null}
          </span>
        </button>
        <span className="am-metrics">
          {account.unknown ? null : (
            <span className={cn("num am-use", tone)}>{usageText(account.usePct, order)}</span>
          )}
          <b className="num">{formatCost(account.costUSD)}</b>
        </span>
        <button
          type="button"
          className="am-only"
          aria-label={`Only ${account.label}`}
          onClick={() => h.onOnly(tokens)}
        >
          only
        </button>
        {account.memberships.length > 0 ? (
          <button
            type="button"
            className="am-chev"
            aria-expanded={open}
            aria-label={
              open ? `Hide ${account.label}'s Memberships` : `Show ${account.label}'s Memberships`
            }
            onClick={onOpen}
          >
            {several ? <span className="num">{`${on}/${account.memberships.length}`}</span> : null}
            {open ? <ChevronDown /> : <ChevronRight />}
          </button>
        ) : null}
      </div>
      {open ? nested.map((m) => <MembershipRow key={m.token} m={m} {...h} />) : null}
    </div>
  );
}

export interface AccountMenuContentProps extends RowHandlers {
  model: AccountMenuModel;
  provider: ProviderChoice;
  order: MenuOrder;
  query: string;
  // The fold is open.
  expanded: boolean;
  // Accounts the user opened.
  opened: ReadonlySet<string>;
  onQuery: (q: string) => void;
  onOrder: (o: MenuOrder) => void;
  onExpand: (e: boolean) => void;
  onOpen: (key: string) => void;
  onClear: () => void;
  onManage: () => void;
}

// The menu itself, pure: search past six Accounts, the selection pinned under
// "Selected · ‹N›" with Clear, the rest ranked under "Others" (or "All
// accounts"), folded after the top five past six, the "Account not known" row
// last, and the footer. Arrow keys move between the checkbox rows
// (`nextOptionIndex`); Tab reaches each row's "only" and chevron.
export function AccountMenuContent(props: AccountMenuContentProps): React.ReactElement {
  const { model, provider, order, query } = props;
  const inProvider = (a: MenuAccount): boolean => provider === "all" || a.provider === provider;
  const accounts = model.accounts.filter(inProvider);
  const unknown = model.unknown !== null && inProvider(model.unknown) ? model.unknown : null;
  const many = accounts.length > MENU_FOLD_AFTER;
  const searching = many && query.trim() !== "";
  const ranked = rankAccounts(accounts, order);
  const touched = (a: MenuAccount): boolean => a.memberships.some((m) => m.selected);
  const pinned = !model.isAll;
  const chosen = pinned
    ? [...ranked.filter(touched), ...(unknown && touched(unknown) ? [unknown] : [])]
    : [];
  const rest = ranked.filter((a) => !chosen.includes(a));
  const restUnknown = unknown && !chosen.includes(unknown) ? unknown : null;
  const matches = (a: MenuAccount) => matchAccount(a, searching ? query : "");
  const shown = searching
    ? rest.filter((a) => matches(a).matches)
    : many && !props.expanded
      ? rest.slice(0, MENU_TOP)
      : rest;
  const showUnknown =
    restUnknown !== null && (!searching || matches(restUnknown).matches) ? restUnknown : null;
  const row = (a: MenuAccount): React.ReactElement => {
    const m = matches(a);
    const orgHit = searching && m.memberships.size > 0;
    return (
      <AccountRow
        key={a.key}
        account={a}
        order={order}
        open={orgHit || props.opened.has(a.key)}
        shown={searching ? m.memberships : undefined}
        onOpen={() => props.onOpen(a.key)}
        onToggle={props.onToggle}
        onOnly={props.onOnly}
      />
    );
  };
  const matchCount = shown.length + (showUnknown ? 1 : 0);
  return (
    <>
      {many ? (
        <div className="am-search">
          <Search aria-hidden />
          <input
            className="input"
            type="search"
            value={query}
            placeholder="Find an Account or Organization"
            aria-label="Find an Account or Organization"
            onChange={(e) => props.onQuery(e.target.value)}
          />
        </div>
      ) : null}
      <div
        className="am-scroll"
        role="menu"
        aria-label="Accounts"
        onKeyDown={(event) => {
          const rows = [
            ...event.currentTarget.querySelectorAll<HTMLElement>("[data-account-option]"),
          ];
          const next = nextOptionIndex(
            event.key,
            rows.indexOf(document.activeElement as HTMLElement),
            rows.length,
          );
          if (next === null) return;
          event.preventDefault();
          rows[next]?.focus();
        }}
      >
        {chosen.length > 0 ? (
          <>
            <div className="menu-head am-head">
              <span>Selected · {chosen.length}</span>
              <button type="button" className="am-headbtn" onClick={props.onClear}>
                Clear
              </button>
            </div>
            {chosen.map(row)}
            <div className="opt-sep" />
          </>
        ) : null}
        <div className="menu-head am-head">
          <span>
            {searching ? `Matching · ${matchCount}` : chosen.length > 0 ? "Others" : "All accounts"}
          </span>
          {searching ? null : (
            <span className="am-order" role="group" aria-label="Rank by">
              {(["used", "free"] as const).map((o) => (
                <button
                  key={o}
                  type="button"
                  className={cn(order === o && "active")}
                  aria-pressed={order === o}
                  onClick={() => props.onOrder(o)}
                >
                  {o === "used" ? "Most used" : "Most free"}
                </button>
              ))}
            </span>
          )}
        </div>
        {shown.map(row)}
        {many && !searching && rest.length > MENU_TOP ? (
          <button
            type="button"
            className="opt am-more"
            aria-expanded={props.expanded}
            onClick={() => props.onExpand(!props.expanded)}
          >
            {props.expanded ? `Show the top ${MENU_TOP}` : foldLine(rest.slice(MENU_TOP), order)}
          </button>
        ) : null}
        {showUnknown ? row(showUnknown) : null}
        {searching && matchCount === 0 ? (
          <div className="am-empty">No Account or Organization matches.</div>
        ) : null}
      </div>
      <div className="am-foot">
        <span>
          {model.untrackedCount > 0
            ? `${model.untrackedCount} not tracked, so not here.`
            : "Every Account seen is tracked."}
        </span>
        <button type="button" onClick={props.onManage}>
          Manage Accounts ›
        </button>
      </div>
    </>
  );
}

// The rail's range and the filters beside the Account filter, which its money
// follows; never the Scope.
export interface AccountFilterProps {
  since: string | undefined;
  until: string | undefined;
}

export function AccountFilter({ since, until }: AccountFilterProps): React.ReactElement | null {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const { data: accountsData } = useAccounts();
  const organizationLabels = useOrganizationLabels();
  const projects = useProjectAxis().projectParams;
  const models = useFilters((s) => s.models);
  const machines = useMachineAxis().machineParams;
  const navigate = useNavigate();
  const nowMs = useNowTick(60_000);
  const visible = accountsData !== undefined && accountFilterVisible(accountsData.accounts);
  // Every Membership's money in the rail's range and filters: all accounts,
  // whatever the menu selects (#620 item 4).
  const totalsQ = useMembershipTotals(
    {
      since,
      until,
      mode: settings?.costMode ?? "auto",
      tz: settings?.timezone,
      projects,
      models,
      machines,
      account: ["all"],
      organization: ["all"],
    },
    { enabled: visible },
  );

  const [menuOpen, setMenuOpen] = useState(false);
  const [provider, setProvider] = useState<ProviderChoice>("all");
  const [order, setOrder] = useState<MenuOrder>("used");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());

  const model = useMemo(
    () =>
      settings && accountsData
        ? accountMenuModel({
            accounts: accountsData.accounts,
            settings,
            totals: totalsQ.data?.memberships,
            organizationLabels,
            nowMs,
          })
        : null,
    [settings, accountsData, totalsQ.data, organizationLabels, nowMs],
  );
  if (!visible || model === null) return null;

  // A choice whose Provider no tracked Account has any more reads All.
  const shownProvider = provider === "all" || model.providers.includes(provider) ? provider : "all";
  const write = (scope: ScopeSetting | null): void => {
    void update({ scope });
  };
  return (
    <>
      <ProviderSwitch providers={model.providers} value={shownProvider} onChange={setProvider} />
      <div className="field">
        <span className="eyebrow">Account</span>
        <Popover
          open={menuOpen}
          onOpenChange={(o) => {
            setMenuOpen(o);
            if (!o) {
              setQuery("");
              setExpanded(false);
            }
          }}
        >
          <PopoverTrigger
            className={cn("chip select", model.isDefault && "placeholder")}
            aria-haspopup="menu"
          >
            <span className="truncate">{triggerSummary(model)}</span>
            <ChevronDown aria-hidden />
          </PopoverTrigger>
          <PopoverContent
            side="right"
            align="start"
            sideOffset={14}
            className="menu am-menu w-[440px] gap-0 rounded-[14px] border-[var(--panel-border)] p-[5px] shadow-none ring-0"
          >
            <AccountMenuContent
              model={model}
              provider={shownProvider}
              order={order}
              query={query}
              expanded={expanded}
              opened={opened}
              onQuery={setQuery}
              onOrder={setOrder}
              onExpand={setExpanded}
              onOpen={(key) => {
                const next = new Set(opened);
                if (!next.delete(key)) next.add(key);
                setOpened(next);
              }}
              onToggle={(tokens) => write(toggleScope(model, tokens))}
              onOnly={(tokens) => write(onlyScope(model, tokens))}
              onClear={() => write(clearScope())}
              onManage={() => {
                setMenuOpen(false);
                // Settings › Accounts, where they are tracked (#639).
                void navigate(`/settings#${SETTINGS_ACCOUNTS_ANCHOR}`);
              }}
            />
          </PopoverContent>
        </Popover>
        <div className="readout num">{readoutLine(model)}</div>
      </div>
    </>
  );
}
