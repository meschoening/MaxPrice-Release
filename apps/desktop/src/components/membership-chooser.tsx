import { useRef, useState } from "react";
import type { ChooserOption } from "@/lib/session-assignment";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { nextOptionIndex } from "@/lib/option-keys";

// The Membership chooser behind Settings › Unattributed usage's `Assign to…`
// (#312; Memberships since #639): a glass menu (`.menu`, `.opt`, `.opt-sep`)
// listing the Memberships the selected sessions' owner-less usage can count
// under. A pick is a write, not a scope or a state, so it is a menu of plain
// items, none checked: the list holds presumed sessions, which hold no claim.

function chooserHead(count: number): string {
  return count === 1
    ? "Count 1 session's owner-less usage under"
    : `Count ${count} sessions' owner-less usage under`;
}

export interface MembershipChooserContentProps {
  // The selected sessions.
  count: number;
  // membershipChooserOptions: Home, the other tracked, then the Excluded.
  options: readonly ChooserOption[];
  onPick: (option: ChooserOption) => void;
}

// The menu itself, pure: the head, the Memberships in tracked Organizations
// (Home marked "(home)"), a separator, then those in Excluded Organizations,
// marked "excluded". The first option is the menu's only tab stop, and arrow
// keys move between the options, wrapping; Home and End jump to the ends
// (`nextOptionIndex`).
export function MembershipChooserContent({
  count,
  options,
  onPick,
}: MembershipChooserContentProps): React.ReactElement {
  const head = chooserHead(count);
  const tracked = options.filter((option) => option.tracked);
  const excluded = options.filter((option) => !option.tracked);
  const tabStop = [...tracked, ...excluded][0]?.key;
  const item = (option: ChooserOption): React.ReactElement => {
    return (
      <li role="none" key={option.key}>
        <button
          type="button"
          role="menuitem"
          tabIndex={option.key === tabStop ? 0 : -1}
          data-chooser-option
          className="opt w-full"
          onClick={() => onPick(option)}
        >
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
// Clicks inside stop here, so a click in the menu never reaches the list rows
// it sits among in the React tree.
export function MembershipChooser({
  count,
  options,
  disabled,
  className,
  children,
  onPick,
}: MembershipChooserContentProps & {
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
        <MembershipChooserContent
          count={count}
          options={options}
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
