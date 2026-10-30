import { readSecret } from "@maxprice/usage-core/secret-input";
import type { Io } from "./main";

// The Headless client's side of reading a secret, for `key set` and `hub
// join --password` (ADR-0121 §6.2, §8). The reader itself is usage-core's
// secret-input.ts, which the Hub's `key set` and `password set` share
// (ADR-0126 §6, ADR-0128 §6); here are the seams a test fills in its place,
// the reader and the clock an entry's `setAt` is read from.

export type ReadSecret = (prompt: string) => Promise<string | null>;

// What `key` and `hub` take from a test; production passes none.
export type SecretsDeps = {
  // In place of the real stdin.
  readSecret?: ReadSecret;
  // The clock an entry's `setAt` is read from.
  now?: () => number;
};

export function secretReader(io: Io, deps: SecretsDeps): ReadSecret {
  return (
    deps.readSecret ?? ((prompt) => readSecret(prompt, { stdin: process.stdin, stderr: io.stderr }))
  );
}

// An entry's `setAt`: now, as an ISO timestamp.
export function setAtNow(deps: SecretsDeps): string {
  return new Date((deps.now ?? Date.now)()).toISOString();
}
