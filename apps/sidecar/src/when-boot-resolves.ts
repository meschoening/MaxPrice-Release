/**
 * Run `work` once a boot promise (`localReady` or `engineReady`) RESOLVES, and
 * nothing if it rejects. Every `void`ed `.then` main() hangs off either one
 * goes through here (#340), and so do fleet's two resumes of a pending Hub
 * forget, off `localReady` as its `ingestionReady` (#389).
 *
 * Resolve, not settle: unlike the three wirings beside main() in index.ts
 * (`wireReadySignal`, `wireScanCachePersist`, `wireIdentityProbe`), work wired
 * here never runs after a failed boot. The rejection is observed here
 * because every caller `void`s the chain — unobserved, it reaches the
 * `unhandledRejection` handler, which exits(1), and the shell never respawns a
 * sidecar that has announced its port. It is not logged here:
 * `wireReadySignal` logs the failed boot once.
 *
 * Only the boot promise's rejection is observed. A throw from `work` still
 * rejects the returned chain, so it still reaches the global handler.
 *
 * Returns the chain so tests can await it; its callers `void` it.
 */
export function whenBootResolves(ready: Promise<void>, work: () => unknown): Promise<unknown> {
  return ready.then(work, () => {
    // Logged by wireReadySignal.
  });
}
