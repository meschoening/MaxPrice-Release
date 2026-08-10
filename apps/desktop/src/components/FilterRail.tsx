import { useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { MODEL_LEGEND_ORDER } from "@maxprice/shared";
import { buildProjectOptions } from "@/lib/project-options";
import { isOptionSelected, selectedOptionCount, toggleOption } from "@/lib/multi-select";
import { useFilters, type DateRangePreset, resolveDateRange } from "@/state/filters";
import { corpusExtent, ymdShift } from "@/lib/dates";
import { useSettings } from "@/state/use-settings";
import { useProjects } from "@/state/use-projects";
import { useMachineAxis } from "@/state/use-machine-axis";
import { useProjectAxis } from "@/state/use-project-axis";
import { shortMachineId } from "@/lib/machines";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const PRESETS: DateRangePreset[] = ["24h", "7d", "30d", "90d", "all"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The sidebar's filter fields (glass.html): date presets as a seg pill +
// resolved readout, then Project / Model / Machine select chips whose menus
// are floating glass leaves. Filter semantics are frozen — the rail drives
// the same store the old rail drove.
export function FilterRail() {
  const dateRange = useFilters((s) => s.dateRange);
  const setDateRange = useFilters((s) => s.setDateRange);
  // ADR-0062: the project axis is the rail's ONE source for project checkbox
  // state — `selected` is the persisted parent slugs, `index` the Repo
  // identity fold the options are built through.
  const projectAxis = useProjectAxis();
  const setProjects = useFilters((s) => s.setProjects);
  const models = useFilters((s) => s.models);
  const setModels = useFilters((s) => s.setModels);
  const machines = useFilters((s) => s.machines);
  const setMachines = useFilters((s) => s.setMachines);
  const machineAxis = useMachineAxis();
  const { data: settings } = useSettings();
  const tz = settings?.timezone;

  const { since, until } = resolveDateRange(dateRange, tz);
  const projectsQ = useProjects({
    since,
    until,
    mode: settings?.costMode ?? "auto",
    tz,
  });

  // Options come from the rows the rail's range actually has data for — never
  // from the Identity directory alone (ADR-0062: a replica-off client mirrors
  // foreign rows with no data behind them). The option *value* stays a slug
  // (the group representative, the server-side filter key); the label is the
  // project's name, path-disambiguated only where names still collide — see
  // `lib/project-options`.
  const projectOptions = useMemo(
    () => buildProjectOptions(projectsQ.data?.projects ?? [], projectAxis.index),
    [projectsQ.data, projectAxis.index],
  );

  // `all` resolves to no bounds, so its readout shows the extent of the data
  // instead — derived from the rows the project menu is already built from, so
  // no extra request. Until they arrive (or on an empty corpus) `rangeReadout`
  // falls back to a plain label. Like every other date in the app this steps on
  // the next refetch rather than on a timer, so a midnight rollover lands with
  // the next refresh (the ADR-0022 precedent).
  const readout = useMemo(() => {
    if (since === undefined && until === undefined) {
      const extent = corpusExtent(projectsQ.data?.projects ?? [], ymdShift(0, tz));
      if (extent) return rangeReadout(extent.since, extent.until);
    }
    return rangeReadout(since, until);
  }, [since, until, projectsQ.data, tz]);

  const modelOptions = useMemo(
    () => (MODEL_LEGEND_ORDER as readonly string[]).map((m) => ({ value: m, label: m })),
    [],
  );

  const machineOptions = useMemo(
    () =>
      machineAxis.folded.map((m) => ({
        value: m.machineId,
        label: m.name ?? shortMachineId(m.machineId),
        note: m.isSelf ? "(this)" : undefined,
      })),
    [machineAxis.folded],
  );

  return (
    <div className="flex flex-col">
      <div className="field">
        <span className="eyebrow">Date range</span>
        <div className="presets seg" role="group" aria-label="Date range presets">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setDateRange(p)}
              className={cn(p === dateRange && "active")}
              aria-pressed={p === dateRange}
            >
              {p === "all" ? "All" : p}
            </button>
          ))}
        </div>
        <div className="readout num">{readout}</div>
      </div>

      <div className="field">
        <span className="eyebrow">Project</span>
        {/* Checked-state matches on group MEMBERSHIP (ADR-0062 §5): a Repo
            identity group's option carries every member checkout's parent
            slug, so a selection persisted under any member checks the box —
            and unchecking removes them all. */}
        <MultiSelectLeaf
          label="All projects"
          options={projectOptions}
          selected={projectAxis.selected}
          onChange={setProjects}
          searchPlaceholder="Search projects…"
        />
      </div>

      <div className="field">
        <span className="eyebrow">Model</span>
        {/* The filterable families — the shared legend order (every real family,
            Unknown excluded), so a new family lands in the rail without a local
            edit. */}
        <MultiSelectLeaf
          label="All models"
          options={modelOptions}
          selected={models}
          onChange={setModels}
        />
      </div>

      {machineAxis.enabled ? (
        <div className="field">
          <span className="eyebrow">Machine</span>
          {/* Options are alias-folded directory TARGETS; "(this)" marks the
              local machine (rail + legend only — ADR-0041). */}
          <MultiSelectLeaf
            label="All machines"
            options={machineOptions}
            selected={machines}
            onChange={setMachines}
            searchPlaceholder="Search machines…"
          />
        </div>
      ) : null}
    </div>
  );
}

// `searchText` lets an option match the search box on more than it renders —
// the project options label by name but stay searchable by full path.
// `members` lets one option stand for several stored values (a Repo identity
// group, ADR-0062); absent, the option stands for its own value alone.
type Option = {
  value: string;
  label: string;
  note?: string;
  searchText?: string;
  members?: string[];
};

type MultiSelectLeafProps = {
  label: string;
  options: Option[];
  selected: string[];
  onChange: (v: string[]) => void;
  searchPlaceholder?: string;
};

// A select chip whose menu is a floating glass leaf (.menu/.opt) — Radix
// Popover supplies the float/outside-click/one-at-a-time semantics; option
// clicks keep the menu open (multi-select, INTERACTIONS.md). The focus
// pattern: empty = "All X"; picking from All narrows to that one; toggling
// members after; selecting everything resets to All.
function MultiSelectLeaf({
  label,
  options,
  selected,
  onChange,
  searchPlaceholder,
}: MultiSelectLeafProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // The summary counts CHECKBOXES, not stored values (F35): under Repo identity
  // one option stands for several member slugs, so `selected.length` could read
  // "2 selected" with a single box checked — reachable both by the v12→v13
  // migration (which dedupes identical parent slugs only, so two checkouts of
  // one repo survive as two entries) and transiently at runtime, while the
  // Identity directory query is still pending and the two checkouts are still
  // two options. selectedOptionCount adds back any stored value no option
  // covers, so a selection whose project has no rows in the current date range
  // — rendered as a raw slug — still counts as one rather than vanishing.
  const count = selectedOptionCount(options, selected);
  const summary =
    selected.length === 0
      ? label
      : count === 1
        ? // Either the one checked option (its label, even when the stored value
          // is a non-representative member of the group) or, with nothing
          // checked, the lone uncovered value shown raw.
          (options.find((o) => isOptionSelected(o, selected))?.label ?? selected[0] ?? label)
        : `${count} selected`;

  const visible = useMemo(() => {
    if (query === "") return options;
    const q = query.toLowerCase();
    return options.filter((o) => (o.searchText ?? o.label).toLowerCase().includes(q));
  }, [options, query]);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger
        // `selected.length`, not the checkbox count: the placeholder tint means
        // "nothing is stored" (the All state the wire sees), which is exactly
        // when the chip shows its bare label.
        className={cn("chip select", selected.length === 0 && "placeholder")}
        aria-haspopup="listbox"
      >
        <span className="truncate">{summary}</span>
        <ChevronDown aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="menu w-[var(--radix-popover-trigger-width)] min-w-[220px] gap-0 rounded-[14px] border-[var(--panel-border)] p-[5px] shadow-none ring-0"
      >
        {searchPlaceholder ? (
          <input
            className="input mb-1"
            placeholder={searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        ) : null}
        <ul role="listbox" aria-multiselectable="true" aria-label={label} className="flex flex-col">
          {/* Also `selected.length`: the action clears STORED values, so it must
              offer itself whenever any exist — including a selection whose only
              entries are uncovered by the current options and therefore have no
              checkbox to untick. */}
          {selected.length > 0 ? (
            <li>
              <button type="button" className="opt w-full text-soft" onClick={() => onChange([])}>
                Clear selection
              </button>
            </li>
          ) : null}
          {visible.length === 0 ? (
            <li className="px-2 py-1.5 text-[12px] text-soft">No options</li>
          ) : (
            visible.map((o) => {
              // Membership overlap, never value equality (ADR-0062 §5) — and
              // toggling routes through lib/multi-select, where the deselect-
              // removes-all-members and all-boxes-reset rules pin under test.
              const isSel = isOptionSelected(o, selected);
              return (
                <li key={o.value} role="option" aria-selected={isSel}>
                  <button
                    type="button"
                    className={cn("opt w-full", isSel && "checked")}
                    onClick={() => onChange(toggleOption(options, selected, o))}
                  >
                    <span className="box" aria-hidden>
                      <Check strokeWidth={3.5} />
                    </span>
                    <span className="truncate">{o.label}</span>
                    {o.note ? <em>{o.note}</em> : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

// Reads the RESOLVED window, not the preset — so it stays honest if a preset's
// bounds ever change, and one branch covers however many presets resolve to a
// given shape. Both bounds absent is `all` (ADR-0068); the caller normally
// hands that case a data-derived extent instead, so "All time" here is the
// fallback for an empty or not-yet-loaded corpus. Rendering it as "… – …" was
// faithful but unreadable — indistinguishable from a label that failed to load.
// A single absent bound keeps the "…" the open-start case has always used; no
// preset resolves that way today.
function rangeReadout(since: string | undefined, until: string | undefined): string {
  if (!since && !until) return "All time";
  const fmt = (ymd: string) => {
    // Guard malformed input: fall back to the raw string rather than render
    // "undefined 01, NaN" if the YYYYMMDD slices aren't all digits.
    if (!/^\d{8}$/.test(ymd)) return ymd;
    const y = Number(ymd.slice(0, 4));
    const m = Number(ymd.slice(4, 6));
    const d = Number(ymd.slice(6, 8));
    if (m < 1 || m > 12) return ymd;
    return `${MONTHS[m - 1]} ${String(d).padStart(2, "0")}, ${y}`;
  };
  return `${since ? fmt(since) : "…"} – ${until ? fmt(until) : "…"}`;
}
