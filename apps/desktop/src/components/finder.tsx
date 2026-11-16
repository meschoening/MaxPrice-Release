import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Search } from "lucide-react";
import {
  accountFilterVisible,
  deriveProjectPath,
  foldProjectRows,
  formatCalendarDay,
  formatCost,
  parentProjectSlug,
  RANGE_LABEL,
  resolveDateRange,
} from "@maxprice/shared";
import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { AccountAvatar } from "@/components/account-filter";
import { ModelBadges } from "@/components/model-badges";
import { accountMenuModel, onlyScope, rankAccounts } from "@/lib/account-menu";
import { backgroundResidencySupported } from "@/lib/background-residency";
import {
  enterTarget,
  finderResults,
  finderSettings,
  finderShortcut,
  flatHits,
  type FinderHit,
  finderSessionPath,
  UNKNOWN_QUERY,
  UNKNOWN_TAG,
} from "@/lib/finder";
import { nextOptionIndex } from "@/lib/option-keys";
import { isMacOS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useFilters } from "@/state/filters";
import { useAllMembershipsScope } from "@/state/use-all-memberships-scope";
import { useAutostart } from "@/state/use-autostart";
import { useFinder, useFinderHotkey } from "@/state/use-finder";
import { useAccounts, useOrganizationLabels } from "@/state/use-organizations";
import { useProjectAxis } from "@/state/use-project-axis";
import { useProjects } from "@/state/use-projects";
import { useScope } from "@/state/use-scope";
import { useSessions } from "@/state/use-sessions";
import { useSettings, useUpdateSettings } from "@/state/use-settings";
import { useUnattributedShown } from "@/state/use-unattributed-sessions";
import { useWeekWindow } from "@/state/use-week";

// The ⌘K finder (#620 item 3, #640): a palette over sessions, projects,
// Accounts and Settings. The rules are `lib/finder.ts`; this renders them and
// carries out each result. Radix Dialog supplies the modal's focus trap,
// Escape, the veil's click-to-close and the return of focus on close.

const MAC = isMacOS();
const SHORTCUT = finderShortcut(MAC);
const LISTBOX_ID = "finder-results";
const optionId = (i: number): string => `finder-option-${i}`;

// The topbar's Find chip: opens the finder, and shows the chord that does.
export function FinderTrigger(): React.ReactElement {
  const setOpen = useFinder((s) => s.setOpen);
  return (
    <button
      type="button"
      className="chip finder-chip"
      aria-label={`Find (${SHORTCUT.aria})`}
      title={`Find (${SHORTCUT.aria})`}
      onClick={(e) => {
        // WebKit does not focus a clicked button, and the dialog hands focus
        // back to whatever held it when it opened.
        e.currentTarget.focus();
        setOpen(true);
      }}
    >
      <Search aria-hidden />
      Find
      <kbd aria-hidden>{SHORTCUT.kbd}</kbd>
    </button>
  );
}

// The finder itself, mounted once in the main window's frame. Its body, and
// with it every query, mounts only while it is open.
export function Finder(): React.ReactElement {
  useFinderHotkey();
  const open = useFinder((s) => s.open);
  const setOpen = useFinder((s) => s.setOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content className="menu finder" aria-describedby={undefined}>
          <DialogPrimitive.Title className="sr-only">Find</DialogPrimitive.Title>
          {open ? <FinderBody onClose={() => setOpen(false)} /> : null}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

function FinderBody({ onClose }: { onClose: () => void }): React.ReactElement {
  const navigate = useNavigate();
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const setProjects = useFilters((s) => s.setProjects);
  const { multi } = useScope();
  const allScope = useAllMembershipsScope();
  const projectIndex = useProjectAxis().index;
  const { data: accountsData } = useAccounts();
  const organizationLabels = useOrganizationLabels();
  const autostart = useAutostart().data;
  const unattributed = useUnattributedShown();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  // The haystack: the rail's Date range under every tracked Membership, with
  // none of the rail's other filters and never the Account filter (#620's
  // review; `lib/finder.ts`).
  const tz = settings?.timezone;
  const dateRange = useFilters((s) => s.dateRange);
  const week = useWeekWindow();
  const { since, until } = resolveDateRange(dateRange, tz, week);
  const rangeLabel = RANGE_LABEL[dateRange];
  const input = {
    since,
    until,
    mode: settings?.costMode ?? "auto",
    tz,
    ...allScope,
    projects: [],
    models: [],
    machines: [],
  };
  const ready = { enabled: settings !== undefined };
  const sessionsQ = useSessions(input, ready);
  const projectsQ = useProjects(input, ready);

  const groups = useMemo(
    () => foldProjectRows(projectsQ.data?.projects ?? [], projectIndex),
    [projectsQ.data, projectIndex],
  );
  const menu = useMemo(
    () =>
      settings && accountsData && accountFilterVisible(accountsData.accounts)
        ? accountMenuModel({
            accounts: accountsData.accounts,
            settings,
            totals: undefined,
            organizationLabels,
            nowMs: Date.now(),
          })
        : null,
    [settings, accountsData, organizationLabels],
  );
  const settingsList = useMemo(
    () =>
      finderSettings({
        background: backgroundResidencySupported(),
        autostart: autostart !== undefined && autostart !== "unsupported",
        mac: MAC,
        unattributed,
        // Settings › Accounts' Home select shows past one Account (#621).
        homeMembership: (accountsData?.accounts.length ?? 0) > 1,
      }),
    [autostart, unattributed, accountsData],
  );
  const results = useMemo(
    () =>
      finderResults({
        query,
        sessions: sessionsQ.data?.sessions ?? [],
        projects: groups,
        accounts: menu ? rankAccounts(menu.accounts, "used") : null,
        settings: settingsList,
        multi,
      }),
    [query, sessionsQ.data, groups, menu, settingsList, multi],
  );
  const hits = useMemo(() => flatHits(results), [results]);

  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const go = (hit: FinderHit): void => {
    onClose();
    switch (hit.kind) {
      case "session":
        void navigate(finderSessionPath(hit.row.sessionId));
        return;
      case "project":
        // A parent slug, as Projects' "Open in Live" writes (the rail's value
        // space holds parents only; the axis widens one to its worktrees).
        setProjects([parentProjectSlug(hit.row.slug)]);
        void navigate("/projects");
        return;
      case "account":
        if (menu) {
          void update({
            scope: onlyScope(
              menu,
              hit.account.memberships.map((m) => m.token),
            ),
          });
        }
        return;
      case "setting":
        void navigate(`${hit.setting.to}#${hit.setting.section}`);
    }
  };

  const loading = sessionsQ.isPending || projectsQ.isPending;
  const q = query.trim();
  const now = Date.now();
  let index = -1;
  return (
    <>
      <div className="finder-search">
        <Search aria-hidden />
        <input
          autoFocus
          className="search"
          role="combobox"
          aria-label="Find"
          aria-expanded={hits.length > 0}
          aria-controls={LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={hits[active] ? optionId(active) : undefined}
          spellCheck={false}
          autoComplete="off"
          value={query}
          placeholder="Find a session id, project, model, Account or setting…"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              const next = nextOptionIndex(e.key, active, hits.length);
              if (next !== null) setActive(next);
              e.preventDefault();
            } else if (e.key === "Enter") {
              const target = enterTarget(hits, active);
              if (target) go(target);
              e.preventDefault();
            }
          }}
        />
      </div>
      <div
        className="finder-scroll thin-scroll"
        id={LISTBOX_ID}
        role="listbox"
        aria-label="Results"
      >
        {q === "" ? (
          <div className="finder-empty">
            Try a session id, a project, a model such as <b>opus</b>, an Account
            {multi ? (
              <>
                , or <b>{UNKNOWN_QUERY}</b>
              </>
            ) : null}
            . Sessions and projects of {rangeLabel}.
          </div>
        ) : null}
        {results.map((group) => (
          <div key={group.kind} role="group" aria-labelledby={`finder-group-${group.kind}`}>
            <div className="menu-head" id={`finder-group-${group.kind}`}>
              {group.title}
            </div>
            {group.hits.map((hit) => {
              index += 1;
              const i = index;
              return (
                <div
                  key={hit.key}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  className={cn("opt finder-row", i === active && "active")}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => go(hit)}
                >
                  <HitRow hit={hit} tz={tz} now={now} rangeLabel={rangeLabel} />
                </div>
              );
            })}
          </div>
        ))}
        {q !== "" && hits.length === 0 ? (
          <div className="finder-empty">{loading ? "Loading…" : "Nothing matches."}</div>
        ) : null}
      </div>
    </>
  );
}

function HitRow({
  hit,
  tz,
  now,
  rangeLabel,
}: {
  hit: FinderHit;
  tz: string | undefined;
  now: number;
  // The rail's Date range, which the project's cost answers.
  rangeLabel: string;
}): React.ReactElement {
  switch (hit.kind) {
    case "session":
      return (
        <>
          <b className="num finder-id">{hit.row.sessionId.slice(0, 8)}</b>
          <span className="finder-name">{hit.project}</span>
          <ModelBadges models={hit.row.modelsUsed} className="finder-models" />
          {hit.unknown ? (
            <span
              className="attr-tag presumed"
              title="No Attribution evidence and no assignment: its Account can't be determined, and it counts under its Presumed membership"
            >
              {UNKNOWN_TAG}
            </span>
          ) : null}
          <span className="finder-end num">{formatCost(hit.row.totalCost)}</span>
          <em className="finder-when">{formatCalendarDay(hit.row.lastActivity, tz, now)}</em>
        </>
      );
    case "project":
      return (
        <>
          <b className="finder-name">{hit.name}</b>
          <span className="finder-path">{deriveProjectPath(hit.row.path)}</span>
          <span className="finder-end num">{formatCost(hit.row.costRange)}</span>
          <em className="finder-when">{rangeLabel}</em>
        </>
      );
    case "account":
      return (
        <>
          <AccountAvatar account={hit.account} />
          <span className="am-name">
            <b>{hit.account.label}</b>
            {hit.account.sub !== null ? <span className="am-sub">{hit.account.sub}</span> : null}
          </span>
          <em className="finder-end">filter to it</em>
        </>
      );
    case "setting":
      return <b className="finder-name">{hit.setting.label}</b>;
  }
}
