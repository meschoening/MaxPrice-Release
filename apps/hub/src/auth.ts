// Exported via a package.json subpath solely for the sidecar fleet test rig (apps/sidecar/src/test-hub.ts) — keep signatures stable, a cross-app test contract.
import { constantTimeEqual } from "@maxprice/usage-core";

// Hub auth gate (ADR-0037): an OPTIONAL user-set password replaces the minted
// bearer token. Three lanes, checked in order:
//   1. the per-launch operator secret (embedded tray console only) — always
//      accepted, so the console works with or without a password;
//   2. no password set ⇒ open: every request passes and any presented
//      credential is IGNORED (upgrade-friendly: pre-0037 clients still send
//      their stale hex tokens);
//   3. password set ⇒ `Authorization: Bearer <password>` must argon2-verify
//      against the stored hash. Successful plaintexts are cached (single slot —
//      there is only ever one valid password) so steady-state requests cost one
//      constant-time compare, not a slow argon2 verify; the cache clears on
//      every password change. A symmetric single-slot NEGATIVE cache short-
//      circuits a repeated wrong bearer, and every cache-missing argon2 verify
//      is serialized through a mutex so a burst of distinct wrong bearers can't
//      run unbounded memory-hard verifies in parallel (F28).

// 32 random bytes as hex — the per-launch operator secret (and the same shape
// the retired hub.json token had, for whatever that nostalgia is worth).
export function mintOperatorSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type HubAuth = {
  verify: (authorizationHeader: string | undefined) => Promise<boolean>;
  setPasswordHash: (hash: string | null) => void;
  passwordProtected: () => boolean;
};

export function createHubAuth(opts: {
  passwordHash: string | null;
  operatorSecret: string | null;
}): HubAuth {
  let hash = opts.passwordHash;
  let verifiedPlaintext: string | null = null;
  // Single-slot NEGATIVE cache (F28): the last plaintext that argon2 REJECTED
  // against the current hash. A retry of the same wrong bearer short-circuits
  // to false without paying another (memory-hard, ~64MiB) argon2 verify. Sound
  // because the hash only changes via setPasswordHash, which clears BOTH slots —
  // so within one hash a rejected plaintext is deterministically always rejected.
  let rejectedPlaintext: string | null = null;
  const expectedOperator = opts.operatorSecret === null ? null : `Bearer ${opts.operatorSecret}`;

  // Serialize argon2 verifies (F28): each is memory-hard, so an unbounded burst
  // of distinct cache-missing bearers could exhaust memory. A promise-chain
  // mutex runs them one at a time; only the argon2 call is wrapped — the
  // operator / positive-cache / negative-cache fast paths stay fully concurrent.
  let chain: Promise<void> = Promise.resolve();
  const serialize = <T>(f: () => Promise<T>): Promise<T> => {
    const p = chain.then(f);
    chain = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  };

  return {
    verify: async (header) => {
      if (
        expectedOperator !== null &&
        header !== undefined &&
        constantTimeEqual(header, expectedOperator)
      ) {
        return true;
      }
      if (hash === null) return true;
      if (header === undefined || !header.startsWith("Bearer ")) return false;
      const presented = header.slice("Bearer ".length);
      if (verifiedPlaintext !== null && constantTimeEqual(presented, verifiedPlaintext)) {
        return true;
      }
      // Negative cache: an identical, already-rejected plaintext fails fast and
      // never re-runs argon2. Constant-time compare so this leaks no more timing
      // than the positive fast path above.
      if (rejectedPlaintext !== null && constantTimeEqual(presented, rejectedPlaintext)) {
        return false;
      }
      // Snapshot the hash for this verify: a setPasswordHash landing while
      // argon2 runs must not let this (old-hash) result re-poison the caches
      // it just cleared — the rotation would never lock a retrying stale
      // client out. The in-flight request itself may still pass (same
      // per-request semantics as a live stream surviving a password change);
      // only the persistent cache writes are gated.
      // verify throws on a malformed stored hash — fail closed, not loud.
      const hashAtCall = hash;
      const ok = await serialize(() =>
        Bun.password.verify(presented, hashAtCall).catch(() => false),
      );
      if (hash === hashAtCall) {
        if (ok) verifiedPlaintext = presented;
        else rejectedPlaintext = presented;
      }
      return ok;
    },
    setPasswordHash: (next) => {
      hash = next;
      verifiedPlaintext = null;
      rejectedPlaintext = null;
    },
    passwordProtected: () => hash !== null,
  };
}
