import { z } from "zod";

// GET /api/readout — the tray readout's single wire (map #168 T5; ADR-0076).
// The Rust ambient writer in the desktop shell polls this ~1/min and renders
// the Windows tray tooltip / macOS menu-bar title from it. All the math is
// sidecar-side, on purpose: `todayCost` comes from the same store query + daily
// aggregator the Live page's Today tile reads, so the tray is penny-exact with
// Live by construction and the shell does zero date math (no chrono-tz; the
// ADR-0060 one-tz-clock invariant stays intact). `mode` / `tz` arrive as
// query params, read by the shell from settings.json on every poll — the
// sidecar keeps its "no ambient mode/tz" invariant.
export const readoutResponseSchema = z.object({
  // The metric switch (charter decision 5, mirroring `usage-ring.ts`): a
  // current usage sample exists AND its fiveHour.resetAt is still ahead of
  // now. True ⇒ the readout shows the 5-hour-limit percent; false ⇒ today's
  // cost.
  blockLive: z.boolean(),
  // The sample's fiveHour.utilizationPct, present exactly while `blockLive` —
  // one bit, one representation: a stale percent beside `blockLive: false`
  // would invite exactly the stale-reading bug ADR-0030 retired.
  utilizationPct: z.number().nullable(),
  // Today's total cost in the requested zone + cost mode — the Today tile's
  // number (ADR-0020's calendar-day window), 0 when today has no events.
  todayCost: z.number(),
  // The status snapshot's range-independent `hasData` bit, carried here so the
  // shell's vanish rule (T5 decision 6: fresh install ⇒ bare app name, no
  // "$0.00") costs one poll instead of two.
  hasData: z.boolean(),
  // Whether the current sample carries a Model-scoped weekly limit — the tray
  // popout draws one extra limit row for it, and the shell sizes the popout
  // window before showing it (windows are shell-owned; ADR-0050/0076), so the
  // shell learns the row's presence here rather than from the webview.
  hasModelWindow: z.boolean(),
});
export type ReadoutResponse = z.infer<typeof readoutResponseSchema>;
