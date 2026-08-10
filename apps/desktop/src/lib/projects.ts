import type { DailyRow, ProjectRow } from "@maxprice/shared";
import { parentProjectPath, parentProjectSlug, slugToPath } from "@maxprice/shared";
import type { IdentityIndex } from "@/lib/project-identity";
import { mergeBreakdowns, mergeRows, unionInOrder } from "@/lib/rollup";

// ADR-0061 — the renderer's project-identity toolbox: a repository and every
// Claude Code worktree beneath it are ONE project.
//
// The engine and the wire stay slug-exact — a worktree keeps its own slug, its
// own row, and its own events — exactly as the machine axis stays id-exact with
// all alias resolution renderer-side (ADR-0041). Everything that decides what a
// user sees as one project lives here.
//
// The membership rule itself is in `@maxprice/shared` (`parentProjectSlug`),
// because the sidecar's `project=` predicate has to agree with it byte for byte:
// selecting a folded group sends the parent slug, and the store widens it to the
// same members this module rolled up. If the two ever disagreed, a group's
// displayed total and its filtered drill-down would silently differ.
//
// ADR-0062 adds a SECOND stage above that fold: parents sharing a Repo
// identity (the same repo checked out in two places, usually on two machines)
// merge into one group. Stage 2 sees PARENT slugs only — worktrees have
// already folded — and an absent context degenerates to stage-1 behavior
// exactly, which is what keeps the golden suites provably inert.

// The fold takes `lib/project-identity.ts`'s IdentityIndex directly (ADR-0062
// §5 — answered for PARENT slugs only). A narrower local echo of it lived here
// first, to keep the fold directory-agnostic, but `membersOf` — which
// `canonicalGroupSlug` needs in order to key a group on its representative even
// when only ONE member was observed — had to be added to it, at which point the
// two declarations were character-identical and the narrowness the comment
// claimed no longer existed. A duplicate that cannot diverge is only a second
// place to edit. `project-identity.ts` imports nothing from this module, so
// depending on it directly costs no cycle.

// The deterministic representative pick (ADR-0062 §5): the local checkout when
// one exists, else the lexicographic-min parent slug — and several LOCAL
// checkouts (two clones of one repo on this machine) tie-break
// lexicographically too, never by observation order, so rows, series, options
// and the machine × project grid all name one group by one slug.
//
// Stated as ONE total ordering (local outranks foreign, then slug ascending)
// rather than filter-then-min, which is what makes it TOTAL: it reduces from
// `items[0]` with a seed, so there is no empty-pool hole — the earlier
// seedless `reduce` threw on empty input and stated that precondition nowhere,
// leaving both call sites to paper over it with `as` casts. The
// `readonly [T, ...T[]]` parameter makes the precondition the type system's
// problem instead, and the callers' maps below build exactly that tuple.
//
// Generic over the ITEM rather than over slugs so a caller can pick the anchor
// OBJECT in one step; picking a slug and then `find`-ing it back is precisely
// the round trip whose "this must exist" step needed the cast.
function pickRepresentative<T>(
  items: readonly [T, ...T[]],
  slugOf: (item: T) => string,
  identity: IdentityIndex,
): T {
  const outranks = (b: T, a: T): boolean => {
    const bLocal = identity.isLocal(slugOf(b));
    const aLocal = identity.isLocal(slugOf(a));
    return bLocal === aLocal ? slugOf(b) < slugOf(a) : bLocal;
  };
  const [head, ...tail] = items;
  return tail.reduce((a, b) => (outranks(b, a) ? b : a), head);
}

const itself = (s: string): string => s;

// The slug a group is KEYED on, picked from the directory's full membership
// rather than from what one payload happened to observe. This is the
// twin-chips guarantee for the machine × project cross: each machine's nested
// map usually observes only ITS checkout, and downstream the maps join by
// slug — so both must answer the same key for the same repo. Falls back to the
// caller's best-observed slug when the directory has no members for the key
// (unprobed parents key to themselves, so those groups are singletons anyway).
//
// The fallback arrives already picked, rather than as the observed list, so
// this function never has to re-prove a list non-empty that the caller has
// already reduced.
function canonicalGroupSlug(
  key: string,
  observedFallback: string,
  identity: IdentityIndex,
): string {
  const assertedTarget = identity.representativeOf(key);
  if (assertedTarget !== null) return assertedTarget.anchor;
  const [first, ...more] = identity.membersOf(key);
  return first === undefined
    ? observedFallback
    : pickRepresentative([first, ...more], itself, identity);
}

// The directory to display for a group SEEDED by a worktree row — a repository
// worked in only through worktrees, or whose own activity falls outside the
// date range.
//
// Two shapes of `path` reach a worktree row and they need OPPOSITE treatment,
// so the discriminator is path PROVENANCE, never "did stripping shorten it":
//
//   - A real `cwd` (`D:\git\MaxPrice\.claude\worktrees\t8`) — strip the marker.
//   - The sidecar's no-`cwd` fallback, `slugToPath(slug)`
//     (`D//git/MaxPrice//claude/worktrees/t8`): every "." became "-" on the way
//     into the slug and comes back as "/", so `/.claude/worktrees/` simply is
//     not there, `parentProjectPath` returns the string whole, and the group
//     would be displayed and named after the worktree LEAF. Decode the parent
//     slug instead — exact for this shape, since the leaf is all that differs.
//
// "Didn't shorten" cannot tell those apart, because a third shape is common and
// already correct: a worktree bucket whose capture never latched `exact` keeps
// its FIRST `cwd`, routinely the parent repo's REAL path (see the sidecar's
// `engine/project-path.ts`). `parentProjectPath` rightly returns it unchanged,
// and a did-it-shorten rule would swap that real path for a lossy one.
//
// The equality test is provably inert on both real-path shapes: `slugToPath`
// output contains no ".", "\" or ":", while every real worktree path contains
// `.claude` and every real parent path is a genuine cwd.
function worktreeGroupPath(slug: string, path: string, parent: string): string {
  return path === slugToPath(slug) ? slugToPath(parent) : parentProjectPath(path);
}

// One project as the UI understands it: the folded total, plus the directories
// it was folded from.
export type ProjectGroup = {
  // The group's own row — parent slug, parent directory, everything summed.
  // Carries the same shape as any ProjectRow so every existing cell renderer
  // works on it unchanged.
  row: ProjectRow;
  // The rows this was folded from, the project's OWN directory first and its
  // worktrees after (ADR-0061: the own row is the anchor the others branched
  // from, not a peer, so it does not move under sorting).
  //
  // A `members.length === 1` group is an ordinary project with no worktrees. It
  // must render exactly as it did before this existed — no disclosure control,
  // no child, no name repeated beneath itself.
  members: ProjectRow[];
};

// A group's parent slug, as `pickRepresentative`'s `slugOf`.
const groupSlug = (g: ProjectGroup): string => g.row.slug;

function minDefined(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a < b ? a : b;
}

function maxStr(a: string, b: string): string {
  return a > b ? a : b;
}

// Sum a member into a group's accumulating row. Every field folds by the rule
// its meaning demands: counts and money add, activity dates take their extreme,
// label arrays union, per-model breakdowns merge.
//
// `sessions` adds rather than deduping because sessions are partitioned BY slug
// upstream — one session belongs to exactly one project directory — so the
// counts are over disjoint sets and summing them is exact, not an estimate.
function absorb(into: ProjectRow, m: ProjectRow): ProjectRow {
  return {
    ...into,
    costRange: into.costRange + m.costRange,
    totalTokens: into.totalTokens + m.totalTokens,
    inputTokens: into.inputTokens + m.inputTokens,
    outputTokens: into.outputTokens + m.outputTokens,
    cacheCreationTokens: into.cacheCreationTokens + m.cacheCreationTokens,
    cacheReadTokens: into.cacheReadTokens + m.cacheReadTokens,
    modelsUsed: unionInOrder(into.modelsUsed, m.modelsUsed),
    machines: unionInOrder(into.machines, m.machines),
    modelBreakdowns: mergeBreakdowns(into.modelBreakdowns, m.modelBreakdowns),
    lastActivity: maxStr(into.lastActivity, m.lastActivity),
    sessions: into.sessions + m.sessions,
    ...(minDefined(into.firstActivity, m.firstActivity) !== undefined
      ? { firstActivity: minDefined(into.firstActivity, m.firstActivity) }
      : {}),
  };
}

// Fold a project list so each repository appears once, carrying its worktrees'
// spend. Groups come back in first-appearance order of their parent slug;
// callers sort (the tables by column, the rail by cost). With an identity
// context, a second stage then merges parents sharing a Repo identity
// (ADR-0062); `undefined` is exactly today's stage-1 behavior.
export function foldProjectRows(
  rows: readonly ProjectRow[],
  identity?: IdentityIndex,
): ProjectGroup[] {
  const byParent = new Map<string, ProjectGroup>();

  for (const r of rows) {
    const parent = parentProjectSlug(r.slug);
    const isOwn = parent === r.slug;
    const existing = byParent.get(parent);

    if (!existing) {
      byParent.set(parent, {
        // Seed from this member, then re-key onto the parent. When the seed IS
        // a worktree — a repository worked in only through worktrees, or whose
        // own activity falls outside the date range — the group's directory is
        // derived from the worktree's path by `worktreeGroupPath`, which is
        // where the two path provenances part company.
        //
        // For a REAL path that derivation is exact rather than a guess:
        // `slugFromPath(parentProjectPath(p))` is provably the same string as
        // `parentProjectSlug(slugFromPath(p))` (pinned in packages/shared).
        // That commute is scoped to real paths deliberately — it demonstrably
        // fails for a slug-DECODED one, which is the whole reason
        // `worktreeGroupPath` branches on provenance instead.
        row: {
          ...r,
          slug: parent,
          path: isOwn ? r.path : worktreeGroupPath(r.slug, r.path, parent),
        },
        members: [r],
      });
      continue;
    }

    existing.row = absorb(existing.row, r);
    if (isOwn) {
      // The own row also supplies the group's real directory, replacing any
      // path derived from a worktree that happened to be seen first.
      existing.row.path = r.path;
      existing.members.unshift(r);
    } else {
      existing.members.push(r);
    }
  }

  if (identity === undefined) return [...byParent.values()];

  // Stage 2 (ADR-0062 §5): merge parent groups sharing a Repo identity. The
  // canonical representative supplies the group's slug-typed key; the ANCHOR —
  // the canonical member when it has rows, else the best observed member by
  // the same pick rule — supplies the displayed path. The two differ only when
  // the canonical checkout has no rows in the window, where the observed
  // member's path is the honest display anyway.
  //
  // `[ProjectGroup, ...ProjectGroup[]]`, not `ProjectGroup[]`: the literal at
  // the `set` site is what proves each list non-empty to the type checker, so
  // the anchor pick below needs no cast and no runtime guard. The `get`/`set`
  // split replaces a `?? []` that erased exactly that proof.
  const byKey = new Map<string, [ProjectGroup, ...ProjectGroup[]]>();
  for (const g of byParent.values()) {
    const key = identity.keyOf(g.row.slug);
    const list = byKey.get(key);
    if (list) list.push(g);
    else byKey.set(key, [g]);
  }
  const out: ProjectGroup[] = [];
  for (const [key, list] of byKey) {
    // The best OBSERVED member, picked as an object in one step. It is both the
    // canonical slug's fallback and the anchor's, so the two can never be
    // picked by different rules.
    const observedAnchor = pickRepresentative(list, groupSlug, identity);
    const slug = canonicalGroupSlug(key, observedAnchor.row.slug, identity);
    const observedTarget = list.find((g) => g.row.slug === slug);
    const anchor = observedTarget ?? observedAnchor;
    const assertedTarget = identity.representativeOf(key);
    if (list.length === 1) {
      out.push(
        anchor.row.slug === slug && observedTarget !== undefined
          ? anchor
          : {
              row: {
                ...anchor.row,
                slug,
                ...(observedTarget === undefined && assertedTarget !== null
                  ? { path: assertedTarget.path }
                  : {}),
              },
              members: anchor.members,
            },
      );
      continue;
    }
    const rest = list.filter((g) => g !== anchor);
    // `absorb` spreads `into` first, so the anchor's slug/path survive the
    // summing — the same property the stage-1 seed re-keys lean on. The slug
    // is then re-keyed onto the canonical representative where they differ.
    let row = anchor.row;
    for (const g of rest) row = absorb(row, g.row);
    if (row.slug !== slug || (observedTarget === undefined && assertedTarget !== null)) {
      row = {
        ...row,
        slug,
        ...(observedTarget === undefined && assertedTarget !== null
          ? { path: assertedTarget.path }
          : {}),
      };
    }
    // Members: every checkout-own row leads (the anchor's first, the others by
    // slug), then all worktrees in the same checkout order.
    const owns = [anchor, ...rest.sort((a, b) => (a.row.slug < b.row.slug ? -1 : 1))];
    const members = [
      ...owns.flatMap((g) => g.members.filter((m) => parentProjectSlug(m.slug) === m.slug)),
      ...owns.flatMap((g) => g.members.filter((m) => parentProjectSlug(m.slug) !== m.slug)),
    ];
    out.push({ row, members });
  }
  return out;
}

// A group's members split the way a tree table wants them: checkout-own
// directories lead and never sort (the representative's first — the order
// `members` already carries), worktrees follow and do. Generalized from one
// pinned own row to N by ADR-0062: a merged group leads with EVERY checkout's
// own directory.
//
// The lead is empty for a group with no own row — a repository worked in only
// through worktrees. Nothing is invented to stand in for it; there simply is no
// spend outside the worktrees to show.
export function groupChildren(g: ProjectGroup): { lead: ProjectRow[]; rest: ProjectRow[] } {
  return {
    lead: g.members.filter((m) => parentProjectSlug(m.slug) === m.slug),
    rest: g.members.filter((m) => parentProjectSlug(m.slug) !== m.slug),
  };
}

// --- chart series ------------------------------------------------------------

// The per-project series shape both chart paths normalize to before composing:
// `/api/daily-by-project`'s instances map and `/api/intraday`'s `byProject`
// entries alike.
export type ProjectSeriesEntry = { path: string; rows: DailyRow[] };

// A series entry with its slug carried alongside — the record shape the
// identity stage buckets, so its anchor pick works on objects rather than on
// slugs it would then have to look back up. Local to this module: nothing
// outside it ever sees a series as anything but a keyed record.
type SeriesPair = readonly [slug: string, entry: ProjectSeriesEntry];

const pairSlug = (p: SeriesPair): string => p[0];

// Fold per-project chart series onto their repositories — and, with an
// identity context, onto their Repo identities (ADR-0062): a second pass
// merges parents sharing `keyOf`, keyed on the representative parent slug,
// which is what collapses the twin legend chips.
//
// This runs BEFORE top-N ranking, which is the point rather than an
// implementation detail: unfolded, one repository's dozen worktrees competed for
// the top-N slots individually and could crowd every other project out of the
// chart while each looking too small to matter.
export function foldProjectSeries(
  entries: Record<string, ProjectSeriesEntry>,
  identity?: IdentityIndex,
): Record<string, ProjectSeriesEntry> {
  const out: Record<string, ProjectSeriesEntry> = {};
  for (const [slug, entry] of Object.entries(entries)) {
    const parent = parentProjectSlug(slug);
    const isOwn = parent === slug;
    const existing = out[parent];
    if (!existing) {
      out[parent] = {
        // Same seed rule, and same provenance branch, as the row fold's — the
        // two must name a worktree-only group identically or a legend chip and
        // its table row would disagree.
        path: isOwn ? entry.path : worktreeGroupPath(slug, entry.path, parent),
        rows: entry.rows.map((r) => ({ ...r })),
      };
      continue;
    }
    out[parent] = {
      // Prefer the project's own directory over one derived from a worktree.
      path: isOwn ? entry.path : existing.path,
      rows: mergeRows(existing.rows, entry.rows),
    };
  }
  if (identity === undefined) return out;

  // Stage 2: parents sharing a Repo identity merge under the CANONICAL
  // representative slug — picked from the directory's full membership by the
  // same rule as foldProjectRows, so for the same observed data a chart series
  // and its table row always agree about a group's slug and displayed path.
  // Crucially the canonical key does NOT depend on which members this map
  // observed: two machines' nested maps, each holding only its own checkout,
  // still key one repo identically, which is what joins them into one project
  // value (and one legend chip) downstream.
  //
  // The buckets hold [slug, entry] PAIRS rather than slugs, for the same reason
  // the row fold's hold groups: carrying the entry along is what lets the anchor
  // be picked as an object, so nothing has to look a "must exist" slug back up
  // in `out` and assert the result. The tuple element type proves non-emptiness
  // to the type checker at the `set` site.
  const byKey = new Map<string, [SeriesPair, ...SeriesPair[]]>();
  for (const [slug, entry] of Object.entries(out)) {
    const key = identity.keyOf(slug);
    const list = byKey.get(key);
    if (list) list.push([slug, entry]);
    else byKey.set(key, [[slug, entry]]);
  }
  const folded: Record<string, ProjectSeriesEntry> = {};
  for (const [key, list] of byKey) {
    // The anchor supplies the path: the canonical member's entry when this map
    // observed it, else the best observed member's (same pick rule).
    const observedAnchor = pickRepresentative(list, pairSlug, identity);
    const slug = canonicalGroupSlug(key, pairSlug(observedAnchor), identity);
    const observedTarget = list.find((p) => pairSlug(p) === slug);
    const anchor = observedTarget ?? observedAnchor;
    const assertedTarget = identity.representativeOf(key);
    const path =
      observedTarget === undefined && assertedTarget !== null
        ? assertedTarget.path
        : anchor[1].path;
    if (list.length === 1) {
      folded[slug] = path === anchor[1].path ? anchor[1] : { ...anchor[1], path };
      continue;
    }
    let rows = anchor[1].rows;
    for (const pair of list) {
      if (pair === anchor) continue;
      rows = mergeRows(rows, pair[1].rows);
    }
    folded[slug] = { path, rows };
  }
  return folded;
}

// Fold the per-project sub-maps nested inside per-machine series entries — the
// machine × project cross. The machine level is untouched; only each machine's
// project map folds (worktrees AND, given a context, Repo identities), so a
// machine's spend on any checkout of a repository lands on that machine's row
// for the repository rather than on a series of its own.
export function foldMachineProjectSeries<
  T extends { projects?: Record<string, ProjectSeriesEntry> },
>(entries: Record<string, T>, identity?: IdentityIndex): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [id, entry] of Object.entries(entries)) {
    out[id] = entry.projects
      ? { ...entry, projects: foldProjectSeries(entry.projects, identity) }
      : entry;
  }
  return out;
}
