import { sha256Hex } from "./sha256";

// An email address's key on this machine (ADR-0137 §1): the lowercase hex
// SHA-256 of the trimmed, lower-cased address. The parser keys an Email
// record's evidence by it (the sidecar's engine/jsonl.ts), the pair table maps
// it to an account uuid, and a Gateway record's credential email is hashed by
// it the moment it is read (ADR-0141 §1), so the clear address is never
// stored. It lives here so the Hub can hash a key's email too (ADR-0141 §5).
// The several-Account corpus's generator
// (apps/sidecar/scripts/build-multi-account-corpus.ts) derives its Pending
// account's key the same way.
export function emailHash(address: string): string {
  return sha256Hex(address.trim().toLowerCase());
}
