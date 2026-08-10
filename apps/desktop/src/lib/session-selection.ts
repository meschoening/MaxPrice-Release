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
