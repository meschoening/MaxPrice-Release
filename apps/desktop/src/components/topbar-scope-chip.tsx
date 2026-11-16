import { useMemo, useRef, useState } from "react";
import { Building2, Check, ChevronDown, Info } from "lucide-react";
import { accountFilterVisible, ALL_ORGANIZATIONS } from "@maxprice/shared";
import {
  buildScopeChipView,
  chipScope,
  HIDDEN_SELECTION_NOTE,
  HIDDEN_SELECTION_SHORT,
  optionScope,
  type ScopeChipView,
} from "@/lib/organization-scope-view";
import { nextOptionIndex } from "@/lib/option-keys";
import { useAccounts, useOrganizations } from "@/state/use-organizations";
import { useScope } from "@/state/use-scope";
import { useSettings, useUpdateSettings } from "@/state/use-settings";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// The Organization scope chip (ADR-0106; kept by #637 for one-Account
// installs): the first chip in the topbar's right cluster, on every page,
// answering "whose numbers are these". It exists only while the Account
// filter is hidden (fewer than two tracked Accounts) and two or more
// Organizations are tracked (`buildScopeChipView`), so a single-Organization
// machine, and every several-Account one, renders no chip. Under All it also
// names the head Organization, whose limits and blocks the page still shows.
//
// A pick writes `scope` on the Organization axis alone (`chipScope`): Home as
// `null`, All as `all`, another Organization as its uuid. It invalidates no
// report query: every money query keys on the Scope, so the new Scope is new
// keys.
//
// While the Account filter is hidden a saved Scope naming Accounts or
// Memberships is read as the default (`ScopeView.hiddenSelection`): the chip
// shows Home and carries the note, and an install with no chip shows the note
// alone (`ScopeHiddenNote`). Neither rewrites the file.
export function TopbarScopeChip(): React.ReactElement | null {
  const { data: settings } = useSettings();
  const { data: roster } = useOrganizations();
  const { data: accounts } = useAccounts();
  const { selection, hiddenSelection } = useScope();
  const update = useUpdateSettings();
  // Undecided until /api/accounts answers, so a several-Account install never
  // flashes the chip.
  const filterHidden = accounts !== undefined && !accountFilterVisible(accounts.accounts);
  const view = useMemo(
    () =>
      settings && filterHidden
        ? buildScopeChipView(settings, roster?.organizations ?? [], selection, hiddenSelection)
        : null,
    [settings, filterHidden, roster, selection, hiddenSelection],
  );
  if (view === null) return filterHidden && hiddenSelection ? <ScopeHiddenNote /> : null;
  return (
    <TopbarScopeChipContent
      view={view}
      onPick={(selected) => {
        void update({ scope: chipScope(selected) });
      }}
    />
  );
}

// The note alone, for an install with no chip to carry it: a saved Account
// selection the window does not apply.
export function ScopeHiddenNote(): React.ReactElement {
  return (
    <span role="note" className="chip scope-note" title={HIDDEN_SELECTION_NOTE}>
      <Info aria-hidden className="scope-chip-icon" />
      <span className="truncate" aria-hidden>
        {HIDDEN_SELECTION_SHORT}
      </span>
      <span className="sr-only">{HIDDEN_SELECTION_NOTE}</span>
    </span>
  );
}

// The pure composition — the view handed in so the trigger is testable under
// static rendering. The menu opens on the selected option, and closes on a pick
// or Escape with focus back on the trigger (Radix). Under All the label holds
// its width (`scope-chip-all`) and the quota half is what truncates. With a
// hidden selection the trigger wears an info mark, its accessible name and
// title carry the note, and the menu heads with it.
export function TopbarScopeChipContent({
  view,
  onPick,
}: {
  view: ScopeChipView;
  onPick: (selected: string | null) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const base = view.isAll
    ? `Organization: All organizations, limits from ${view.quotaLabel}`
    : `Organization: ${view.chipLabel}`;
  const label = view.hiddenSelection ? `${base}. ${HIDDEN_SELECTION_NOTE}` : base;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="chip scope-chip"
        aria-haspopup="listbox"
        aria-label={label}
        title={view.hiddenSelection ? HIDDEN_SELECTION_NOTE : "Organization"}
      >
        <Building2 aria-hidden className="scope-chip-icon" />
        <span className={cn("truncate", view.isAll && "scope-chip-all")}>{view.chipLabel}</span>
        {view.isAll ? (
          <span className="scope-chip-quota">{`quota · ${view.quotaLabel}`}</span>
        ) : null}
        {view.hiddenSelection ? <Info aria-hidden className="scope-chip-hidden" /> : null}
        <ChevronDown aria-hidden className="caret" />
      </PopoverTrigger>
      <PopoverContent
        ref={menuRef}
        aria-label="Organization"
        align="end"
        sideOffset={8}
        className="menu w-auto min-w-[230px] gap-0 rounded-[14px] border-[var(--panel-border)] p-[5px] shadow-none ring-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          menuRef.current
            ?.querySelector<HTMLElement>('[data-scope-option][aria-selected="true"]')
            ?.focus({ preventScroll: true });
        }}
      >
        {view.hiddenSelection ? <p className="scope-menu-note">{HIDDEN_SELECTION_NOTE}</p> : null}
        <ScopeOptionList
          view={view}
          onPick={(selected) => {
            setOpen(false);
            onPick(selected);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

// The single-select list: every tracked Organization by its label (Home first,
// marked "(home)"; "no limits" where its Limits answer has none to read), then
// All organizations, which narrows money only. Each option IS its button — the
// focused element carries `role="option"` and `aria-selected`, so a screen
// reader announces the selection — and the selected one is the list's only
// tab stop. Arrow keys move between the options, wrapping; Home and End jump
// to the ends (`nextOptionIndex`).
export function ScopeOptionList({
  view,
  onPick,
}: {
  view: ScopeChipView;
  onPick: (selected: string | null) => void;
}): React.ReactElement {
  return (
    <ul
      role="listbox"
      aria-label="Organization"
      className="flex flex-col"
      onKeyDown={(event) => {
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLElement>("[data-scope-option]"),
        ];
        const current = buttons.findIndex((button) => button === event.target);
        const next = nextOptionIndex(event.key, current, buttons.length);
        if (next === null) return;
        event.preventDefault();
        buttons[next]?.focus({ preventScroll: true });
      }}
    >
      {view.options.map((option) => {
        const value = optionScope(option);
        return (
          <ScopeOptionItem
            key={option.uuid}
            selected={view.selected === value}
            onPick={() => onPick(value)}
          >
            <span className="truncate">{option.label}</span>
            {option.isHome ? <em>(home)</em> : null}
            {option.noLimits ? <em>no limits</em> : null}
          </ScopeOptionItem>
        );
      })}
      <li className="opt-sep" aria-hidden />
      <ScopeOptionItem
        selected={view.selected === optionScope(ALL_ORGANIZATIONS)}
        onPick={() => onPick(optionScope(ALL_ORGANIZATIONS))}
      >
        <span className="truncate">All organizations</span>
        <em>money only</em>
      </ScopeOptionItem>
    </ul>
  );
}

function ScopeOptionItem({
  selected,
  onPick,
  children,
}: {
  selected: boolean;
  onPick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <li role="none">
      <button
        type="button"
        role="option"
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        data-scope-option
        className={cn("opt w-full", selected && "checked")}
        onClick={onPick}
      >
        <span className="box" aria-hidden>
          <Check strokeWidth={3.5} />
        </span>
        {children}
      </button>
    </li>
  );
}
