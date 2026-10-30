import { createDeferredShutdown } from "@maxprice/usage-core";

// The parent-death watchdog's late-bound teardown (ADR-0078). It has a module
// of its own so both of its ends reach it without an import cycle: the entry
// (`index.ts`) arms the watchdog at module scope, before any boot runs, and the
// watchdog fires this; `bootSidecar` (`boot.ts`) calls `.set(shutdown)` once it
// has a teardown to give. Until then an orphaning exits immediately.
// Constructing it costs nothing (no timers, no handles), so importing it for
// `buildApp` in tests, or into a host that arms no watchdog, is unaffected.
export const deferredShutdown = createDeferredShutdown({ label: "sidecar" });
