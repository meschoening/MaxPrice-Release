// Newest-edit-wins merge for the Hub's user-authored directories: #288's
// Organization directory and #310's Organization assertion directory. Each
// entry carries the ISO `editedAt` of the edit that made it; its schema pins
// toISOString()'s exact shape, so string order is time order. A cleared entry
// is a tombstone that still carries its `editedAt`, so an older copy can never
// resurrect it.
export type EditedEntry = { readonly editedAt: string };

// True when `incoming` must replace `incumbent`. The newer edit wins; an equal
// `editedAt` is broken by the entry's canonical JSON, the larger one winning,
// so every replica picks the same winner in any arrival order. An identical
// entry never supersedes: re-adopting what is held changes nothing.
export function editSupersedes<E extends EditedEntry>(
  incoming: E,
  incumbent: E | undefined,
): boolean {
  if (incumbent === undefined) return true;
  if (incoming.editedAt !== incumbent.editedAt) return incoming.editedAt > incumbent.editedAt;
  return canonical(incoming) > canonical(incumbent);
}

// `base` merged with `incoming`, and the keys whose entry changed. `base` is
// never mutated.
export function mergeNewestWins<E extends EditedEntry>(
  base: ReadonlyMap<string, E>,
  incoming: Iterable<readonly [string, E]>,
): { merged: Map<string, E>; changed: string[] } {
  const merged = new Map(base);
  const changed = new Set<string>();
  for (const [key, entry] of incoming) {
    if (!editSupersedes(entry, merged.get(key))) continue;
    merged.set(key, entry);
    changed.add(key);
  }
  return { merged, changed: [...changed] };
}

function canonical(entry: object): string {
  return JSON.stringify(entry, Object.keys(entry).sort());
}
