import { useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { usageTone } from "@maxprice/shared";
import { MembershipNameView } from "@/components/membership-name";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { BlockSpanOption, BlockSpanPick } from "@/lib/block-span-pick";
import { nextOptionIndex } from "@/lib/option-keys";
import { blockSpanNote } from "@/lib/organization-scope-view";
import { cn } from "@/lib/utils";

// The Live chart's note beside its controls on the block span, under All
// organizations: whose block the span frames. The chart head must not wrap for
// it, so a long label ellipsizes (`.chart-span-note`) and the title carries it
// in full.
export function ChartSpanNote({
  span,
  quotaTag,
}: {
  span: string;
  quotaTag: string | null;
}): React.ReactElement | null {
  const note = blockSpanNote(span, quotaTag);
  if (note === null) return null;
  return (
    <span className="chart-span-note" title={note}>
      {note}
    </span>
  );
}

// What sits beside the chart controls: on the Block span with Memberships to
// pick from (`blockSpanPick`'s `picked`, #619 variant 1, #638), the picker;
// everywhere else today's note.
export function ChartSpanControl({
  span,
  quotaTag,
  pick,
  onPick,
}: {
  span: string;
  quotaTag: string | null;
  pick: BlockSpanPick;
  onPick: (token: string) => void;
}): React.ReactElement | null {
  if (span !== "block" || pick.kind !== "picked") {
    return <ChartSpanNote span={span} quotaTag={quotaTag} />;
  }
  return <BlockSpanPicker options={pick.options} selected={pick.selected} onPick={onPick} />;
}

// The menu's items, pure: every Membership with a live Block, most used first,
// with its 5-hour percent; the framed one checked, and the menu's only tab
// stop. Arrow keys move between them, wrapping; Home and End jump to the ends.
export function BlockSpanMenu({
  options,
  selected,
  onPick,
}: {
  options: readonly BlockSpanOption[];
  selected: BlockSpanOption;
  onPick: (token: string) => void;
}): React.ReactElement {
  return (
    <ul
      role="menu"
      aria-label="Whose block the chart frames"
      className="flex flex-col"
      onKeyDown={(event) => {
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-span-option]")];
        const current = items.findIndex((item) => item === event.target);
        const next = nextOptionIndex(event.key, current, items.length);
        if (next === null) return;
        event.preventDefault();
        items[next]?.focus({ preventScroll: true });
      }}
    >
      {options.map((option) => {
        const checked = option.token === selected.token;
        const tone = usageTone(option.pct);
        return (
          <li role="none" key={option.token}>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              data-span-option
              className={cn("opt chart-span-opt w-full", checked && "checked")}
              onClick={() => onPick(option.token)}
            >
              <span className="box" aria-hidden>
                <Check strokeWidth={3.5} />
              </span>
              <MembershipNameView name={option.name} />
              <em className={cn("num", tone && `tone-${tone}`)}>{option.pct}%</em>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// "‹Membership›'s block ▾": the trigger ellipsizes the name, its Organization
// part first (`MembershipNameView`), never the "'s block", and never wraps
// the chart head. The popover opens with focus
// on the checked item and closes on a pick or Escape, focus back on the
// trigger.
function BlockSpanPicker({
  options,
  selected,
  onPick,
}: {
  options: readonly BlockSpanOption[];
  selected: BlockSpanOption;
  onPick: (token: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const title = `${selected.label}'s block`;
  return (
    <span className="chart-span-note chart-span-picker">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          ref={triggerRef}
          className="chart-span-pick"
          aria-haspopup="menu"
          title={title}
        >
          <MembershipNameView name={selected.name} className="chart-span-pick-name" title={title} />
          <span className="chart-span-pick-rest">&apos;s block</span>
          <ChevronDown aria-hidden />
        </PopoverTrigger>
        <PopoverContent
          ref={menuRef}
          align="start"
          sideOffset={6}
          className="menu w-auto min-w-[240px] max-w-[360px] gap-0 rounded-[14px] border-[var(--panel-border)] p-[5px] shadow-none ring-0"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            menuRef.current
              ?.querySelector<HTMLElement>('[data-span-option][tabindex="0"]')
              ?.focus({ preventScroll: true });
          }}
        >
          <BlockSpanMenu
            options={options}
            selected={selected}
            onPick={(token) => {
              setOpen(false);
              triggerRef.current?.focus({ preventScroll: true });
              onPick(token);
            }}
          />
        </PopoverContent>
      </Popover>
    </span>
  );
}
