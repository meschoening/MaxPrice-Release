import { z } from "zod";

// The money half's wide Scope (`ReadoutResponse.wideScope`).
export const readoutWideScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accounts") }),
  z.object({ kind: z.literal("organizations") }),
  z.object({ kind: z.literal("memberships"), count: z.number().int().min(2) }),
]);
export type ReadoutWideScope = z.infer<typeof readoutWideScopeSchema>;

// One Membership's most used live window, as the readout names it
// (`ReadoutMembership`, ./membership-readout.ts): `pct` unrounded, the shell
// rounds it. `label` is null where naming it would tell nothing apart: the
// one Membership of a machine that tracks one Organization.
export const readoutMembershipSchema = z.object({
  label: z.string().nullable(),
  window: z.enum(["fiveHour", "weekly", "weeklyModel"]),
  model: z.string().optional(),
  pct: z.number(),
});

// The Readout's percent (`ReadoutResponse.mostUsed`, `readoutPick`): the most
// used window, whatever its kind, of the most used Readable membership.
export const readoutMostUsedSchema = z.object({
  // The Memberships the Readout reads, every state: `+N more` counts the
  // rest. One on a one-Membership Scope.
  count: z.number().int().min(1),
  top: readoutMembershipSchema,
  // The second most used, for `Next:`; null with none.
  next: readoutMembershipSchema.nullable(),
});
export type ReadoutMostUsed = z.infer<typeof readoutMostUsedSchema>;

// GET /api/readout's flag that its Scope params are the persisted Scope
// (#637): the sidecar applies them as the visible controls can show them
// (`effectiveScope`, ./effective-scope.ts), so on an install tracking one
// Account a saved Account or Membership Scope reads as the default, as the
// Today tile does. The shell sends it beside any `account` or `membership`
// param (ambient.rs `readout_url`; keep in lockstep), never for the default
// or an Organization-axis Scope, whose URLs stay as they were.
export const PERSISTED_SCOPE_PARAM = "persisted";

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
  // Today's total cost in the requested zone + cost mode — the Today tile's
  // number (ADR-0020's calendar-day window), 0 when today has no events.
  todayCost: z.number(),
  // The status snapshot's range-independent `hasData` bit, carried here so the
  // shell's vanish rule (T5 decision 6: fresh install ⇒ bare app name, no
  // "$0.00") costs one poll instead of two.
  hasData: z.boolean(),
  // Whether the one-Membership Popout's reading carries a Model-scoped weekly
  // limit — that Popout draws one extra limit row for it, and the shell
  // sizes the popout window before showing it (windows are shell-owned;
  // ADR-0050/0076), so the shell learns the row's presence here rather than
  // from the webview. Always false for the ranked Popout, which draws none.
  hasModelWindow: z.boolean(),
  // Present only while the request's resolved Scope holds more than one
  // Membership (#622 item 4, #637; `readoutWideScope`): what the money half
  // sums, so the Windows tooltip's today fallback can say so. `accounts`: every
  // tracked Membership of several tracked Accounts ("all accounts");
  // `organizations`: every tracked Organization of one Account ("all
  // organizations", the v0.9.x All organizations wording); `memberships`: any
  // other set of `count` Memberships. Absent under a one-Membership Scope.
  wideScope: readoutWideScopeSchema.optional(),
  // The Readout's percent, at every count (ADR-0142 §2, ADR-0136 §6's note
  // of 2026-11-21): present while some Readable membership the Readout reads
  // holds a window in flight, of any kind. Those are the Scope's
  // multi-Membership set (`scopeMembershipSet`) while it holds two or more,
  // its one Membership's own `/api/accounts` reading while it holds one
  // (#738), else the Scope's head Organization's reading alone. Only a
  // Readable membership counts
  // or drives it; a dead key's stale reading never does (ADR-0138 §8).
  // Absent: today's money.
  mostUsed: readoutMostUsedSchema.optional(),
  // The Popout's limit rows, which the shell sizes the window by before
  // showing it. With two or more Memberships in that set, the ranked
  // Popout's (`rankedPopoutLimitRows`): the four most used plus one `+N more`
  // row past four. Otherwise the one-Membership Popout's 5-hour and weekly
  // rows, one when the Organization it reads (the set's one Membership's,
  // else the head's) reports no weekly limit; its model
  // row is `hasModelWindow`'s, which the shell adds under the Settings
  // opt-in (`popoutLimitRowsOf`).
  popoutLimitRows: z.number().int().min(1),
});
export type ReadoutResponse = z.infer<typeof readoutResponseSchema>;
