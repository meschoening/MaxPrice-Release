import { useMemo, useRef, useState } from "react";
import { Building2, Check, ChevronDown } from "lucide-react";
import { ALL_ORGANIZATIONS } from "@maxprice/shared";
import { buildScopeView, optionScope, type ScopeView } from "@/lib/organization-scope-view";
import { useOrganizations } from "@/state/use-organizations";
import { useSettings, useUpdateSettings } from "@/state/use-settings";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// The Organization scope chip (ADR-0106): the first chip in the topbar's right
// cluster, on every page, answering "whose numbers are these". It exists only
// while two or more Organizations are tracked (`buildScopeView`), so a
// single-Organization machine renders exactly what it did before. Under All it
// also names the Quota organization, whose limits and blocks the page still
// shows.
//
// A pick writes `organizationScope` and nothing else — the option's
// `optionScope`, so Home as `null` and All as `ALL_ORGANIZATIONS` — and
// invalidates no report query: every money query keys on the scope, so the new
// scope is new keys.
export function TopbarScopeChip(): React.ReactElement | null {
  const { data: settings } = useSettings();
  const { data: roster } = useOrganizations();
  const update = useUpdateSettings();
  const view = useMemo(
    () => (settings ? buildScopeView(settings, roster?.organizations ?? []) : null),
    [settings, roster],
  );
  if (view === null) return null;
  return (
    <TopbarScopeChipContent
      view={view}
      onPick={(scope) => {
        void update({ organizationScope: scope });
      }}
    />
  );
}

// The pure composition — the view handed in so the trigger is testable under
// static rendering. The menu opens on the selected option, and closes on a pick
// or Escape with focus back on the trigger (Radix). Under All the label holds
// its width (`scope-chip-all`) and the quota half is what truncates.
export function TopbarScopeChipContent({
  view,
  onPick,
}: {
  view: ScopeView;
  onPick: (scope: string | null) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const label = view.isAll
    ? `Organization scope: All organizations, quota ${view.quotaLabel}`
    : `Organization scope: ${view.chipLabel}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="chip scope-chip"
        aria-haspopup="listbox"
        aria-label={label}
        title="Organization scope"
      >
        <Building2 aria-hidden className="scope-chip-icon" />
        <span className={cn("truncate", view.isAll && "scope-chip-all")}>{view.chipLabel}</span>
        {view.isAll ? (
          <span className="scope-chip-quota">{`quota · ${view.quotaLabel}`}</span>
        ) : null}
        <ChevronDown aria-hidden className="caret" />
      </PopoverTrigger>
      <PopoverContent
        ref={menuRef}
        aria-label="Organization scope"
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
        <ScopeOptionList
          view={view}
          onPick={(scope) => {
            setOpen(false);
            onPick(scope);
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
// to the ends.
export function ScopeOptionList({
  view,
  onPick,
}: {
  view: ScopeView;
  onPick: (scope: string | null) => void;
}): React.ReactElement {
  return (
    <ul
      role="listbox"
      aria-label="Organization scope"
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
        const scope = optionScope(option);
        return (
          <ScopeOptionItem
            key={option.uuid}
            selected={view.selected === scope}
            onPick={() => onPick(scope)}
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

// The option to focus for a key, or null when the key is not the list's.
// `current` is -1 when no option has focus. It belongs beside the list it
// drives; a file of its own would cost more than fast refresh does.
// eslint-disable-next-line react-refresh/only-export-components
export function nextOptionIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowUp":
      return current <= 0 ? count - 1 : current - 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
