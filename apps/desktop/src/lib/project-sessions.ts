import type { SessionRow } from "@maxprice/shared";

// The Projects detail panel's session list (#640, the #620 resolution): the
// sessions of the selected row, the costliest five or every one, narrowed to
// the session ids the table's search matches. Pure, so the rules are testable
// without the page's queries.
//
// A session is NOT a slice of its project's range stats. `/api/sessions`
// keeps a session when its LAST request falls in the range and reports the
// WHOLE session's cost (engine `sessions.ts`, whole-session windowing), while
// every ProjectRow stat answers only the range (ADR-0068). So the list never
// claims to sum to the project's cost; its count says only how many sessions
// end in range.
//
// Slugs: a session is filed under the project directory (`projectSlug`, the
// JSONL directory name) of its first event, and a ProjectRow's `slug` is that
// same directory name, so the two index into one another directly.

export const TOP_SESSIONS = 5;

// The rail's sessions by project slug, each list in the response's order.
export function indexSessionsBySlug(sessions: readonly SessionRow[]): Map<string, SessionRow[]> {
  const out = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    const list = out.get(s.projectPath);
    if (list === undefined) out.set(s.projectPath, [s]);
    else list.push(s);
  }
  return out;
}

// The session ids filed under one slug: a table row's own search keys. A
// folded row passes its own slug only, never its members', so an id from a
// worktree discloses that worktree's child row, as a worktree's name does.
export function sessionIdsOf(index: ReadonlyMap<string, SessionRow[]>, slug: string): string[] {
  return (index.get(slug) ?? []).map((s) => s.sessionId);
}

// Every session filed under any of `slugs`, costliest first. Ties go to the
// later last activity, then the id, so the order never depends on which
// member directory a session came from.
export function sessionsOfSlugs(
  index: ReadonlyMap<string, SessionRow[]>,
  slugs: readonly string[],
): SessionRow[] {
  const out: SessionRow[] = [];
  for (const slug of new Set(slugs)) out.push(...(index.get(slug) ?? []));
  return out.sort(
    (a, b) =>
      b.totalCost - a.totalCost ||
      b.lastActivity.localeCompare(a.lastActivity) ||
      a.sessionId.localeCompare(b.sessionId),
  );
}

// The sessions whose id contains the search text, by the table's own rule
// (trimmed, case-insensitive substring). Empty text matches nothing.
export function matchingSessions(sessions: readonly SessionRow[], search: string): SessionRow[] {
  const needle = search.trim().toLowerCase();
  if (needle === "") return [];
  return sessions.filter((s) => s.sessionId.toLowerCase().includes(needle));
}

export type SessionListView = {
  head: string;
  // The search text a matching list is under, as typed (trimmed), else null.
  // The page sets it apart from the uppercase eyebrow: an id's case matters.
  matching: string | null;
  shown: SessionRow[];
  // How many of the row's sessions end in range — the "of N".
  total: number;
  // The All / Top 5 toggle's label, or null when there is none: five or fewer
  // sessions, or a search narrowing the list to its matches.
  toggle: string | null;
  // The full list, which scrolls inside a bounded height.
  scrolls: boolean;
};

// What the panel shows for a row's sessions (`sessions` costliest first),
// the table's search text, and whether All is on.
export function sessionListView(
  sessions: readonly SessionRow[],
  search: string,
  showAll: boolean,
): SessionListView {
  const total = sessions.length;
  const matches = matchingSessions(sessions, search);
  if (matches.length > 0) {
    return {
      head: `Sessions matching “${search.trim()}”`,
      matching: search.trim(),
      shown: matches,
      total,
      toggle: null,
      scrolls: matches.length > TOP_SESSIONS,
    };
  }
  const canToggle = total > TOP_SESSIONS;
  const all = showAll && canToggle;
  return {
    head: all ? "Every session in range" : "Costliest sessions",
    matching: null,
    shown: all ? [...sessions] : sessions.slice(0, TOP_SESSIONS),
    total,
    toggle: canToggle ? (all ? `Top ${TOP_SESSIONS}` : `All ${total}`) : null,
    scrolls: all,
  };
}
