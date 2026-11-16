import {
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type RefObject,
} from "react";
import { ChevronDown } from "lucide-react";
import {
  abbreviate,
  formatCost,
  usageTone,
  type BlockRow,
  type BlocksAggregate,
  type MembershipName,
} from "@maxprice/shared";
import { DetailStrip, StripIdentity, StripSection, StripStat } from "@/components/detail-strip";
import { MembershipNameView } from "@/components/membership-name";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  activeBlockText,
  BLOCKS_TABS_SHOWN,
  fitTabRow,
  membershipStripSub,
  readableName,
  splitTabs,
  tabFitKey,
  type BlocksTab,
  type BlocksTabsView,
  type TabMeasure,
  type TabRowMeasure,
} from "@/lib/blocks-tabs";
import type { LimitWindowView } from "@/lib/limit-area";
import { cn } from "@/lib/utils";

// The Blocks page's Membership surfaces (#619 A, #638): the tab row and the
// no-selection strip naming one Membership. The rules are `lib/blocks-tabs.ts`;
// `pages/Blocks.tsx` places them.

type TabsView = Extract<BlocksTabsView, { kind: "tabs" }>;

// How many tabs the row shows, and the floor in px each keeps (by token):
// the width that leaves its name readable. No floors while unmeasured, or
// when even one tab's floor is wider than the row.
export type TabFit = { count: number; floors: ReadonlyMap<string, number> };

const UNMEASURED: TabFit = { count: BLOCKS_TABS_SHOWN, floors: new Map() };

// The tab row (#619 A): a tab per Membership, most used first among those
// that form Blocks in the range, then those with none; at most six in the
// row, only as many as show each name readably (#645), and the rest in an
// "‹N› more" menu, in the same order. `lib/blocks-tabs.ts` holds the rules.
export function MembershipTabs({
  view,
  onPick,
}: {
  view: TabsView;
  onPick: (token: string) => void;
}): React.ReactElement {
  const rowRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const fit = useTabFit(view, rowRef, layerRef);
  return (
    <MembershipTabRow view={view} onPick={onPick} fit={fit} rowRef={rowRef} layerRef={layerRef} />
  );
}

// The row drawn at a fit: `MembershipTabs` measures it; tests pass one.
export function MembershipTabRow({
  view,
  onPick,
  fit,
  rowRef,
  layerRef,
}: {
  view: TabsView;
  onPick: (token: string) => void;
  fit: TabFit;
  rowRef?: RefObject<HTMLDivElement | null>;
  layerRef?: RefObject<HTMLDivElement | null>;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const { shown, more } = splitTabs(view.tabs, view.selected, fit.count);
  return (
    <div className="blocks-tabs" ref={rowRef}>
      <div className="seg blocks-tablist" role="tablist" aria-label="Membership">
        {shown.map((tab) => {
          const on = tab.token === view.selected.token;
          const floor = fit.floors.get(tab.token);
          return (
            <TabButton
              key={tab.token}
              tab={tab}
              active={on}
              role="tab"
              aria-selected={on}
              style={floor === undefined ? undefined : { minWidth: floor }}
              onClick={() => onPick(tab.token)}
            />
          );
        })}
      </div>
      {more.length > 0 ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger className="seg blocks-tabs-more">
            {more.length} more <ChevronDown aria-hidden />
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={6}
            className="menu w-[300px] gap-0 rounded-[14px] border-[var(--panel-border)] p-[5px] shadow-none ring-0"
          >
            {more.map((tab) => (
              <button
                key={tab.token}
                type="button"
                className="opt blocks-tabs-opt w-full"
                onClick={() => {
                  onPick(tab.token);
                  setOpen(false);
                }}
              >
                <MembershipNameView name={tab.name} className="blocks-tab-name" />
                <TabBadge tab={tab} />
              </button>
            ))}
          </PopoverContent>
        </Popover>
      ) : null}
      <TabMeasureLayer view={view} layerRef={layerRef} />
    </div>
  );
}

// One tab as the row draws it, and as the measuring layer draws it to
// measure: one markup, so the widths the fit reads are the row's own. `name`
// replaces the tab's (the readable form), and `badge={false}` drops its badge.
function TabButton({
  tab,
  active,
  name = tab.name,
  badge = true,
  ...button
}: {
  tab: BlocksTab;
  active: boolean;
  name?: MembershipName;
  badge?: boolean;
} & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "type" | "className" | "children" | "name"
>): React.ReactElement {
  return (
    <button type="button" className={cn(active && "active") || undefined} {...button}>
      <MembershipNameView name={name} className="blocks-tab-name" />
      {badge ? <TabBadge tab={tab} /> : null}
    </button>
  );
}

// What the fit measures (#645), drawn out of sight: every tab whole, as the
// row draws it (the selected one bold), every name in its readable form
// (`readableName`), and the "‹N› more" button at its widest count. Hidden and
// inert, so nothing in it is announced or reachable.
function TabMeasureLayer({
  view,
  layerRef,
}: {
  view: TabsView;
  layerRef?: RefObject<HTMLDivElement | null>;
}): React.ReactElement {
  return (
    <div className="blocks-tabs-measure" aria-hidden="true" inert ref={layerRef}>
      <div className="seg blocks-tablist">
        {view.tabs.map((tab) => (
          <TabButton
            key={tab.token}
            tab={tab}
            active={tab.token === view.selected.token}
            tabIndex={-1}
            data-measure-tab=""
          />
        ))}
      </div>
      <div className="seg blocks-tablist">
        {view.tabs.map((tab) => (
          <TabButton
            key={tab.token}
            tab={tab}
            active={tab.token === view.selected.token}
            name={readableName(tab.name)}
            badge={false}
            tabIndex={-1}
            data-measure-readable=""
          />
        ))}
      </div>
      <button type="button" tabIndex={-1} className="seg blocks-tabs-more">
        {view.tabs.length - 1} more <ChevronDown aria-hidden />
      </button>
    </div>
  );
}

// Fits the row to its width (#645): measured before the first paint, again
// whenever the tabs or the selection change, and on every resize of the row
// or of a tab in the measuring layer (a window resize, a badge's new text, a
// label arriving, the font arriving).
function useTabFit(
  view: TabsView,
  rowRef: RefObject<HTMLDivElement | null>,
  layerRef: RefObject<HTMLDivElement | null>,
): TabFit {
  const [fit, setFit] = useState<TabFit>(UNMEASURED);
  const { tokens, selected } = tabFitKey(view);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const layer = layerRef.current;
    if (row === null || layer === null) return;
    const order = tokens.split("\n");
    const selectedIndex = Math.max(0, order.indexOf(selected));
    const measure = (): void => {
      const m = measureTabRow(order.length, selectedIndex, row, layer);
      if (m === null) return;
      const next = fitTabRow(order, m);
      setFit((prev) => (sameFit(prev, next) ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    for (const child of layer.children) ro.observe(child);
    for (const tab of layer.querySelectorAll("button")) ro.observe(tab);
    return () => ro.disconnect();
  }, [tokens, selected, rowRef, layerRef]);
  return fit;
}

function sameFit(a: TabFit, b: TabFit): boolean {
  if (a.count !== b.count || a.floors.size !== b.floors.size) return false;
  for (const [token, px] of a.floors) if (b.floors.get(token) !== px) return false;
  return true;
}

// The row's measurements from the DOM: the row's width, the real tab list's
// padding, border and gap, and the measuring layer's natural widths.
function measureTabRow(
  tabCount: number,
  selectedIndex: number,
  row: HTMLElement,
  layer: HTMLElement,
): TabRowMeasure | null {
  const list = row.querySelector<HTMLElement>('[role="tablist"]');
  const more = layer.querySelector<HTMLElement>(".blocks-tabs-more");
  const wholes = layer.querySelectorAll<HTMLElement>("[data-measure-tab]");
  const readables = layer.querySelectorAll<HTMLElement>("[data-measure-readable] .blocks-tab-name");
  if (list === null || more === null) return null;
  if (wholes.length !== tabCount || readables.length !== tabCount) return null;
  const width = (el: Element): number => el.getBoundingClientRect().width;
  const px = (v: string): number => Number.parseFloat(v) || 0;
  const tabs: TabMeasure[] = [];
  for (let i = 0; i < tabCount; i++) {
    const whole = wholes[i]!;
    const name = whole.querySelector(".blocks-tab-name");
    tabs.push({
      width: width(whole),
      nameWidth: name === null ? 0 : width(name),
      // Rounded up, so text measured at a fraction of a px is never clipped.
      readableWidth: Math.ceil(width(readables[i]!)),
    });
  }
  const ls = getComputedStyle(list);
  return {
    available: width(row),
    tabs,
    selectedIndex,
    listInset:
      px(ls.paddingLeft) + px(ls.paddingRight) + px(ls.borderLeftWidth) + px(ls.borderRightWidth),
    gap: px(ls.columnGap),
    moreGap: px(getComputedStyle(row).columnGap),
    moreWidth: width(more),
  };
}

function TabBadge({ tab }: { tab: BlocksTab }): React.ReactElement {
  const { badge } = tab;
  if (badge.kind === "state") return <span className="pill blocks-tab-badge">{badge.text}</span>;
  return (
    <span
      className={cn("pill blocks-tab-badge num", badge.tone !== null && `tone-${badge.tone}`)}
      data-stale={badge.stale || undefined}
      title={badge.stale ? "key expired · last known" : undefined}
    >
      {badge.text}
      {badge.stale ? " · stale" : null}
    </span>
  );
}

// The no-selection strip for one Membership (#619 A): what today's "All
// blocks" strip says, for its Blocks alone, plus its Active block and every
// window of its limits.
export function MembershipStrip({
  tab,
  aggregate,
  rangeLabel,
  activeBlock,
  nowMs,
}: {
  tab: BlocksTab;
  aggregate: BlocksAggregate;
  rangeLabel: string;
  activeBlock: BlockRow | undefined;
  nowMs: number;
}): React.ReactElement {
  return (
    <DetailStrip selected={false}>
      <StripIdentity title={tab.label}>
        <span className="sub num">{membershipStripSub(tab.plan, aggregate.count, rangeLabel)}</span>
      </StripIdentity>

      <StripStat label="total spent">{formatCost(aggregate.totalCost)}</StripStat>
      <StripStat label="total tokens">{abbreviate(aggregate.totalTokens)}</StripStat>
      <StripStat label="active block">
        {activeBlock
          ? activeBlockText(formatCost(activeBlock.costUSD), activeBlock.endTime, nowMs)
          : "—"}
      </StripStat>

      <StripSection label={tab.limitsLabel}>
        {tab.windows.length > 0 ? (
          <span className="blocks-limits" data-stale={tab.state === "stale" || undefined}>
            {tab.windows.map((w) => (
              <LimitsRow key={w.kind} window={w} stale={tab.state === "stale"} />
            ))}
          </span>
        ) : (
          <span className="text-xs text-soft">{tab.limitsNote ?? "—"}</span>
        )}
      </StripSection>

      <span className="strip-hint">Select a row for details</span>
    </DetailStrip>
  );
}

// One window's meter: its percent, or "—" on an empty bar while idle.
function LimitsRow({
  window: w,
  stale,
}: {
  window: LimitWindowView;
  stale: boolean;
}): React.ReactElement {
  const pct = w.pct === null ? null : Math.round(w.pct);
  return (
    <span className={cn("limit-row", pct === null && "idle")}>
      <label title={`${w.label} limit used`}>{w.label}</label>
      <span
        className="limit-meter"
        role="meter"
        aria-valuenow={pct ?? 0}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${w.label} limit used`}
        aria-valuetext={pct === null ? "no window open" : `${pct}%`}
      >
        {pct === null ? null : (
          <i
            data-tone={stale ? "stale" : (usageTone(pct) ?? undefined)}
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        )}
      </span>
      <b className="num">{pct === null ? "—" : `${pct}%`}</b>
    </span>
  );
}
