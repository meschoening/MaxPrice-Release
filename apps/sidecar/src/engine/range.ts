// ADR-0083 decision 3: `since`/`until` come in TWO forms. `YYYYMMDD` is the
// original inclusive local-date bound (golden parity — do not touch its
// semantics). An ISO-8601 instant with a time part is the additive form: an
// event is in `[since, until)` by its own timestamp, no zone involved. Mixed
// forms are rejected at the HTTP layer; every windowing site funnels through
// `inRange` so the two forms cannot drift apart between aggregators.
export type RangeBound = { kind: "ymd"; ymd: string } | { kind: "instant"; ms: number };

// An instant must carry its zone: a trailing `Z` or a `±HH:MM` offset. A
// dashed date WITHOUT a time part (`2026-08-27`) is refused because
// `Date.parse` would read it as UTC midnight where a reader expects a local
// day; a time WITHOUT a zone (`2026-08-27T13:30:00`) is refused because
// `Date.parse` would resolve it in the sidecar HOST's zone — neither the
// user's Timezone setting nor "no zone involved". Callers send
// `toISOString()`, which always ends in `Z`.
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/;

export function isInstantBound(s: string): boolean {
  return INSTANT_RE.test(s) && !Number.isNaN(Date.parse(s));
}

export function parseRangeBound(s: string): RangeBound | null {
  if (isValidYmd(s)) return { kind: "ymd", ymd: s };
  if (isInstantBound(s)) return { kind: "instant", ms: Date.parse(s) };
  return null;
}

// The ONE predicate every windowing site uses. `localYmd` stays lazy — it is
// computed only when the bound is a ymd, so the instant path never formats a
// date.
//
// `timestampMs` used to accept a thunk as well, so the ymd branch could skip an
// eager `Date.parse` worth a measured ~340 ns/event in the projects fold. That
// seam is gone (ADR-0089): every event carries its own `ms`, derived once at
// `upsert`, so the per-event caller passes a plain field read and the closure
// it used to allocate per event goes with it. Row-scale callers already passed
// a number. If a future caller genuinely cannot produce the epoch-ms cheaply,
// bring the thunk back rather than parsing at the call site.
//
// Semantics: ymd bounds are inclusive on the local date; instant bounds are
// `since <= t` and `t < until` on the epoch-ms. Both bounds share a kind (the
// HTTP layer rejects mixed forms), so one instant bound decides the branch.
// Classifying the bounds per call (`isInstantBound` = one regex) is ~40 ns —
// cheap even per event; the store's per-event loop pre-parses its bounds
// instead only because it can hoist them.
export function inRange(
  timestampMs: number,
  localYmd: () => string | null,
  since: string | undefined,
  until: string | undefined,
): boolean {
  if (since === undefined && until === undefined) return true;
  const instant =
    (since !== undefined && isInstantBound(since)) ||
    (until !== undefined && isInstantBound(until));
  if (instant) {
    const t = timestampMs;
    if (since !== undefined && t < Date.parse(since)) return false;
    if (until !== undefined && t >= Date.parse(until)) return false;
    return true;
  }
  // An unformattable local date fails a ymd bound safe — excluded rather than
  // leaking past both bounds (mirrors the store's own date filter).
  const ymd = localYmd();
  if (ymd === null) return false;
  if (since !== undefined && ymd < since) return false;
  if (until !== undefined && ymd > until) return false;
  return true;
}

// A YYYYMMDD string must be both well-formed and a real calendar date.
// `/^\d{8}$/` alone would forward 20261332 (month 13) or 20260230 (Feb 30)
// straight through as a since/until bound. Lives here (moved from index.ts)
// so the HTTP parser and `parseRangeBound` share one definition.
export function isValidYmd(s: string): boolean {
  if (!/^\d{8}$/.test(s)) return false;
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(4, 6));
  const day = Number(s.slice(6, 8));
  if (month < 1 || month > 12) return false;
  // new Date(year, month, 0) is the last day of `month` (1-indexed here).
  const daysInMonth = new Date(year, month, 0).getDate();
  return day >= 1 && day <= daysInMonth;
}
