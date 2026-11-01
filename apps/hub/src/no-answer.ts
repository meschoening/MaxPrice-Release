// The operator commands' answer bound (operator-client.ts's NO_ANSWER_MS,
// ADR-0127 §7) has one seam, build-time, as the update channel has
// (update-channel.ts): a spawned test's shorter bound, and only a test's.
// `bun --define` from source (test-serve.ts's spawns, when a sandbox names
// one) replaces this identifier with a number of ms, so a case that waits out
// a Hub that never answers does so in a second rather than ten. The
// production compile (scripts/build-binaries.ts's compileArgs) defines it as
// `undefined`, so the lookup folds away and the binary carries 10 s alone and
// reads nothing at runtime, where BUN_OPTIONS=--preload could set a global.
//
// Keep this file the only non-test source in src that names the identifier,
// and keep it small: Bun's runtime transpiler cache keeps only large files,
// so a define from source always reaches this one.
declare const MAXPRICE_TEST_NO_ANSWER_MS: number | undefined;

export const TEST_NO_ANSWER_MS: number | undefined =
  typeof MAXPRICE_TEST_NO_ANSWER_MS === "undefined" ? undefined : MAXPRICE_TEST_NO_ANSWER_MS;
