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
// rounds it.
export const readoutMembershipSchema = z.object({
  label: z.string(),
  window: z.enum(["fiveHour", "weekly", "weeklyModel"]),
  model: z.string().optional(),
  pct: z.number(),
});

// The most used readout (`ReadoutResponse.mostUsed`, `readoutPick`).
export const readoutMostUsedSchema = z.object({
  // Some Readable membership's 5-hour window is in flight: the title and the
  // tooltip's head are `top`'s percent. False: money, and `top` is the
  // tooltip's `Most used:` line.
  fiveHourLive: z.boolean(),
  // The Memberships in the set, every state: `+N more` counts the rest.
  count: z.number().int().min(2),
  top: readoutMembershipSchema,
  // The second most used, for `Next:`; null with none, and always null for
  // money.
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
  // Present only while more than one Organization is tracked (ADR-0106 §11,
  // #291): the Quota organization's display label — the rename, plan word or
  // short id, collision-suffixed across the roster, never the upstream name.
  // The utilization half is that one Organization's, and the shell names it in
  // the Windows tooltip from this, never resolving a label itself. Absent, not
  // null, on a single-Organization machine, so its body is byte-identical to
  // before.
  organizations: z.object({ quotaLabel: z.string() }).optional(),
  // Present only while the request's resolved Scope holds more than one
  // Membership (#622 item 4, #637; `readoutWideScope`): what the money half
  // sums, so the Windows tooltip's today fallback can say so. `accounts`: every
  // tracked Membership of several tracked Accounts ("all accounts");
  // `organizations`: every tracked Organization of one Account ("all
  // organizations", the v0.9.x All organizations wording); `memberships`: any
  // other set of `count` Memberships. Absent under a one-Membership Scope, so a
  // single-Organization, single-Account body is byte-identical to before.
  wideScope: readoutWideScopeSchema.optional(),
  // Present only while the Scope's multi-Membership set (`scopeMembershipSet`,
  // two or more tracked Accounts) holds two or more Readable memberships and
  // at least one of them reads a live window (#638; ADR-0136 §6's #610/#622
  // rows, `readoutPick`): the Readout picks the most used one. Only a Readable membership counts or
  // drives it; a dead key's stale reading never does (ADR-0138 §8). Absent
  // otherwise, so a one-Account body is byte-identical to before.
  mostUsed: readoutMostUsedSchema.optional(),
  // Present only while that set holds two or more Memberships: the ranked
  // Popout's limit rows (`rankedPopoutLimitRows`), the four most used plus
  // one `+N more` row past four, which the shell sizes the Popout by before
  // showing it. Absent otherwise: today's Popout and height.
  popoutLimitRows: z.number().int().min(2).optional(),
});
export type ReadoutResponse = z.infer<typeof readoutResponseSchema>;
