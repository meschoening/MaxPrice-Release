// The Organization scope (GLOSSARY.md, #278): which tracked Organization every
// report describes — one uuid, or All organizations. `null` is the Home
// organization, and it is the only form Home ever takes: nothing emits the
// `organization` query param while the scope is Home, so a single-Organization
// machine's query keys and URLs stay byte-identical to before the scope.
//
// The one resolution rule, shared by the renderer (`parseSettings`) and the
// sidecar (the `organization` param), per the #262 decision:
//   - item 1: `null` (or an absent value) is Home;
//   - item 2: a value that names nothing tracked resolves to Home;
//   - item 11: a stale `all` on a machine that tracks only Home resolves to
//     Home, since All over a one-member set is Home;
// and the Home uuid itself normalizes to `null`, so an explicit Home choice
// keeps Home's key and URL rather than forking the cache. No Home (`home ===
// null`) means no narrowing at all — the ADR-0098 null-set rule.

// The All-organizations scope: the union of THIS machine's tracked set.
export const ALL_ORGANIZATIONS = "all";

// Resolve a stored scope against Home and the tracked list. `tracked` is the
// raw list (Home is added here, empty strings dropped), so a hand-edited
// settings.json cannot make Home or "" count as a second member. Pure.
export function resolveOrganizationScope(
  scope: string | null | undefined,
  home: string | null,
  tracked: Iterable<string>,
): string | null {
  if (home === null || scope === null || scope === undefined) return null;
  const members = new Set<string>([home]);
  for (const uuid of tracked) if (uuid !== "") members.add(uuid);
  if (scope === ALL_ORGANIZATIONS) return members.size >= 2 ? ALL_ORGANIZATIONS : null;
  return scope !== home && members.has(scope) ? scope : null;
}
