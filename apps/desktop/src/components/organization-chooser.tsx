import { useRef, useState } from "react";
import { Check } from "lucide-react";
import type { ChooserOption } from "@/lib/session-assignment";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { nextOptionIndex } from "@/components/topbar-scope-chip";
import { cn } from "@/lib/utils";

// The Organization chooser behind the selection bar's `Assign to…` (#312): the
// scope chip's glass menu (topbar-scope-chip.tsx — `.menu`, `.opt`, `.opt-sep`,
// the check box) listing where the selected sessions' owner-less usage should
// count. A pick is a write, not a scope, so it is a menu of radio items, not a
// listbox; the checked one is the assertion every selected session already
// holds, if they share one.

function chooserHead(count: number): string {
  return count === 1
    ? "Count 1 session's owner-less usage under"
    : `Count ${count} sessions' owner-less usage under`;
}

export interface OrganizationChooserContentProps {
  // The selected sessions.
  count: number;
  // chooserOptions: Home, the other tracked, then the Excluded.
  options: readonly ChooserOption[];
  // selectionSummary's sharedTarget.
  checked: string | null;
  onPick: (option: ChooserOption) => void;
}

// The menu itself, pure: the head, the tracked Organizations (Home marked
// "(home)"), a separator, then the Excluded ones, marked "excluded". The
// checked option is the menu's only tab stop — the first option when none is
// checked — and arrow keys move between the options, wrapping; Home and End
// jump to the ends (the scope chip's `nextOptionIndex`).
export function OrganizationChooserContent({
  count,
  options,
  checked,
  onPick,
}: OrganizationChooserContentProps): React.ReactElement {
  const head = chooserHead(count);
  const tracked = options.filter((option) => option.tracked);
  const excluded = options.filter((option) => !option.tracked);
  const tabStop = options.some((option) => option.uuid === checked) ? checked : options[0]?.uuid;
  const item = (option: ChooserOption): React.ReactElement => {
    const isChecked = option.uuid === checked;
    return (
      <li role="none" key={option.uuid}>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={isChecked}
          tabIndex={option.uuid === tabStop ? 0 : -1}
          data-chooser-option
          className={cn("opt w-full", isChecked && "checked")}
          onClick={() => onPick(option)}
        >
          <span className="box" aria-hidden>
            <Check strokeWidth={3.5} />
          </span>
          <span className="truncate">{option.label}</span>
          {option.isHome ? <em>(home)</em> : null}
          {option.tracked ? null : <em>excluded</em>}
        </button>
      </li>
    );
  };
  return (
    <>
      <div className="menu-head" aria-hidden>
        {head}
      </div>
      <ul
        role="menu"
        aria-label={head}
        className="flex flex-col"
        onKeyDown={(event) => {
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLElement>("[data-chooser-option]"),
          ];
          const current = buttons.findIndex((button) => button === event.target);
          const next = nextOptionIndex(event.key, current, buttons.length);
          if (next === null) return;
          event.preventDefault();
          buttons[next]?.focus({ preventScroll: true });
        }}
      >
        {tracked.map(item)}
        {excluded.length > 0 ? <li className="opt-sep" aria-hidden /> : null}
        {excluded.map(item)}
      </ul>
    </>
  );
}

// The popover around it. It opens with focus on the tab stop, and closes on a
// pick or on Escape with focus back on the trigger; a pick closes it before
// `onPick` runs, so an Excluded pick's confirm opens over no menu. A pick
// moves focus to the trigger itself, before `onPick`: the menu lingers through
// its exit animation, so a confirm opening on the pick would otherwise record
// the picked option as where to return focus, and find it detached on close.
// Clicks inside stop here: in the React tree the menu sits inside the strip
// page, which reads a click on dead space as a request to clear the selection.
export function OrganizationChooser({
  count,
  options,
  checked,
  disabled,
  className,
  children,
  onPick,
}: OrganizationChooserContentProps & {
  disabled?: boolean;
  // The trigger's class and content.
  className: string;
  children: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={triggerRef}
        className={className}
        disabled={disabled}
        aria-haspopup="menu"
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        ref={menuRef}
        align="start"
        sideOffset={6}
        className="menu w-auto min-w-[230px] gap-0 rounded-[14px] border-[var(--panel-border)] p-[5px] shadow-none ring-0"
        onClick={(event) => event.stopPropagation()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          menuRef.current
            ?.querySelector<HTMLElement>('[data-chooser-option][tabindex="0"]')
            ?.focus({ preventScroll: true });
        }}
      >
        <OrganizationChooserContent
          count={count}
          options={options}
          checked={checked}
          onPick={(option) => {
            setOpen(false);
            triggerRef.current?.focus({ preventScroll: true });
            onPick(option);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
