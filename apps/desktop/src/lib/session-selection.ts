// Selection ⇄ URL search param helpers for the Sessions list (Part 5, T5.3).
//
// The Sessions-list selected row lives in the `?selected=` search param rather
// than component-local state, so it survives the round trip through the
// /sessions/:id detail page and back. These two pure helpers are the testable
// core; the Sessions page composes them with React Router's useSearchParams.

// The search-param name carrying the selected session id.
export const SELECTED_PARAM = "selected";

// The selected session id, or undefined when the param is absent or empty.
// An empty `?selected=` is treated as no selection rather than an id of "".
export function selectedIdFromParams(params: URLSearchParams): string | undefined {
  return params.get(SELECTED_PARAM) || undefined;
}

// A copy of `prev` with `selected` set to `id` — every other param is carried
// through unchanged, and `prev` is not mutated. Used as the functional updater
// for `setSearchParams`.
export function withSelectedParam(prev: URLSearchParams, id: string): URLSearchParams {
  const next = new URLSearchParams(prev);
  next.set(SELECTED_PARAM, id);
  return next;
}

// A copy of `prev` with `selected` removed — deselection (Esc / re-clicking
// the selected row, ADR-0016). Every other param is carried through unchanged,
// and `prev` is not mutated.
export function withoutSelectedParam(prev: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(prev);
  next.delete(SELECTED_PARAM);
  return next;
}

// The search-param name carrying the owner-less view (#312 ruling 8): the
// Sessions page's `All sessions | Owner-less N` switch. In the URL, beside
// `selected`, so Settings' Review can deep-link to the view and Back leaves it.
export const OWNERLESS_PARAM = "ownerless";

// Whether the page shows the owner-less review list. Only past one tracked
// Organization (`multi`, #312 ruling 7): a single-Organization machine has no
// switch, so a stale `ownerless=1` there is ignored and the page is today's.
export function isOwnerlessView(params: URLSearchParams, multi: boolean): boolean {
  return multi && params.get(OWNERLESS_PARAM) === "1";
}

// A copy of `prev` switched into (`on`) or out of the owner-less view. Either
// way the row selection goes: the review list has no detail strip, and the
// table it returns to starts from its filter totals. Every other param is
// carried through, and `prev` is not mutated.
export function withOwnerlessParam(prev: URLSearchParams, on: boolean): URLSearchParams {
  const next = new URLSearchParams(prev);
  if (on) next.set(OWNERLESS_PARAM, "1");
  else next.delete(OWNERLESS_PARAM);
  next.delete(SELECTED_PARAM);
  return next;
}
