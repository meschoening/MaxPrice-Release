import { activePricingSnapshot, type CostMode, type UsageSample } from "@maxprice/shared";
import {
  foldBlockTotals,
  type BlockFlushContext,
  type BlockTotals,
  type PendingBlock,
} from "./blocks";
import { precomputeSamples, type SampleView } from "./block-windows";
import { lowerModelNeedles } from "./store";

// Match the report cache's four-query LRU budget. Each entry keeps only one
// totals object per live block, never event arrays or a second priced corpus.
const MAX_ENTRIES = 4;
type Entry = WeakMap<PendingBlock, { length: number; totals: BlockTotals }>;

// Owned by createBlockReports, whose formation guard guarantees that a reused
// PendingBlock can ONLY gain suffix events. Any replacement, historical insert,
// geometry change, store swap, change of Quota organization, or presumption
// change under a scoped slot rebuilds with new block objects (ADR-0091).
// Thus object identity + length proves unchanged ordered membership here; it
// is NOT a safe cache for arbitrary caller-mutated PendingBlock arrays.
export function createBlockFlushCache() {
  const entries = new Map<string, Entry>();
  let pricing = activePricingSnapshot();
  let capturedAt: string[] = [];
  let utils: number[] = [];
  let view: SampleView | null = null;

  function sampleView(samples: readonly UsageSample[]): SampleView | null {
    // Compare all values used by precomputeSamples, in input order. Neither
    // array identity nor length detects historical edits or in-place mutation.
    // Retain primitive copies so mutating a previously seen sample is visible.
    if (
      samples.length !== capturedAt.length ||
      samples.some(
        (s, i) => s.capturedAt !== capturedAt[i] || s.fiveHour.utilizationPct !== utils[i],
      )
    ) {
      capturedAt = samples.map((s) => s.capturedAt);
      utils = samples.map((s) => s.fiveHour.utilizationPct);
      view = samples.length > 0 ? precomputeSamples(samples) : null;
    }
    return view;
  }

  return {
    prepare(
      mode: CostMode,
      models: string[],
      machines: string[],
      organizations: string[],
      samples: readonly UsageSample[],
    ): BlockFlushContext {
      const currentPricing = activePricingSnapshot();
      if (pricing !== currentPricing) {
        entries.clear();
        pricing = currentPricing;
      }
      const loweredModels = [...new Set(lowerModelNeedles(models))].sort();
      const machineIds = [...new Set(machines)].sort();
      // Organization uuids are opaque, so they are deduplicated and sorted like
      // the machine ids and never case-folded the way model needles are.
      //
      // THE AXIS IS THE QUOTA ORGANIZATION. `createBlockReports.blocks()` is
      // the only caller: it passes `[Q]` for a request scoped to a Quota
      // organization and `[]` for an unscoped one. ADR-0092 reuses totals on
      // "the same block object and the same event count prove unchanged
      // ordered membership" — a claim about ONE formation. The Organization is
      // a formation-shaping input, so that proof covers only requests for the
      // scope that formed the block; keying the totals by the scope keeps any
      // other scope's request from answering from this formation's entry.
      //
      // It is NOT a member of `AggregateBlocksOptions`, and must not become one:
      // `models`/`machines` are sum-narrowing axes, tested per event inside
      // `foldBlockTotals`, and the Organization is not — it chooses which rows
      // and samples blocks form from. Listing it there would advertise a
      // narrowing the blocks aggregator does not perform.
      const organizationIds = [...new Set(organizations)].sort();
      const key = JSON.stringify([mode, loweredModels, machineIds, organizationIds]);
      let entry = entries.get(key);
      if (entry === undefined) {
        if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
        entry = new WeakMap();
      } else {
        entries.delete(key);
      }
      entries.set(key, entry);
      const totalsByBlock = entry;
      return {
        totals(block) {
          const cached = totalsByBlock.get(block);
          if (cached !== undefined && cached.length === block.events.length) return cached.totals;
          const totals = foldBlockTotals(block, mode, loweredModels, machineIds);
          totalsByBlock.set(block, { length: block.events.length, totals });
          return totals;
        },
        sampleView: sampleView(samples),
      };
    },
  };
}
