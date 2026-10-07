// Repeated string VALUES, held once per process (#361).
//
// `JSON.parse` gives every occurrence of a value its own string, so a corpus
// resident as parsed rows — the walk's scan-cache records, the Local archive,
// the fleet replica — carries one copy per row of values that have only a few
// thousand distinct members across the whole corpus. Measured on a real
// machine's copy (#361), interning these six fields removed 1.5M strings and
// ~70 MB of live heap. Strings are immutable values, so nothing can observe the
// sharing: an interned row is equal to its parse in every field.
//
// ONLY categorical fields belong here. A per-event value (message id, request
// id, timestamp) would make the table a second copy of the corpus. The table
// never shrinks, so a value whose rows were all dropped (a forget, a replica
// wipe, a restrictive rebuild) stays held: a few thousand short strings at
// most, bounded by the sessions, projects and models a machine has ever seen.

const table = new Map<string, string>();

export function internString(value: string): string {
  const held = table.get(value);
  if (held !== undefined) return held;
  table.set(value, value);
  return value;
}

export const INTERNED_ROW_FIELDS = [
  "projectSlug",
  "sessionId",
  "machineId",
  "model",
  "cwd",
  "organizationUuid",
] as const;

type InternedRowFields = { [K in (typeof INTERNED_ROW_FIELDS)[number]]?: string | undefined };

/**
 * Interns a freshly parsed row's categorical fields IN PLACE and returns it.
 * Call it where a row is materialized and before anything else holds it.
 */
export function internRowStrings<T extends InternedRowFields>(row: T): T {
  const fields = row as InternedRowFields;
  for (const field of INTERNED_ROW_FIELDS) {
    const value = fields[field];
    if (typeof value === "string") fields[field] = internString(value);
  }
  return row;
}
