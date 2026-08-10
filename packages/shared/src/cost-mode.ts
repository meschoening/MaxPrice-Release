import { z } from "zod";

export const costModeSchema = z.enum(["auto", "calculate", "display"]);
export type CostMode = z.infer<typeof costModeSchema>;

// The cost-mode option table — the single source of truth for every UI that
// presents the three modes (the topbar dropdown and the Settings page's
// segmented control). The `hint` text mirrors CONTEXT.md's `Cost mode`
// definition and master plan §2.4; both consumers import this rather than
// keeping a local copy (CLAUDE.md: shared tables live in `packages/shared`).
export const COST_MODE_OPTIONS: ReadonlyArray<{
  value: CostMode;
  label: string;
  hint: string;
}> = [
  {
    value: "auto",
    label: "auto",
    hint: "Use costUSD from JSONL when present; else recalc from tokens.",
  },
  { value: "calculate", label: "calculate", hint: "Always recalc from tokens × LiteLLM price." },
  {
    value: "display",
    label: "display",
    hint: "Only what the JSONL recorded; may be $0 on old rows.",
  },
];
