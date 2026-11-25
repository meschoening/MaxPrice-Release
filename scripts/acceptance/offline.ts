// What a harness process may fetch (#296), as a pure function: offline-preload.ts
// applies it to every fetch in a spawned sidecar or Hub, and harness.test.ts pins
// it without patching the test's own fetch.
//
// Two refusals:
//   - any host that is not loopback, so both sides price from the vendored
//     LiteLLM snapshot (ADR-0011/0096) and neither ever reaches claude.ai;
//   - loopback on PRODUCTION_HUB_PORT, the port a real MaxPrice Hub listens on.
//     A harness sidecar handed `MAXPRICE_HUB_URL` or a `hubUrl` setting naming
//     127.0.0.1:47100 would otherwise push its rows to, and pull a replica from,
//     the real Hub on this machine. Every harness Hub and fake claude.ai listens
//     on a port `freeLoopbackPort` picked, which is never this one.
//
// It imports nothing, and must not: headless/fake-github.ts takes `LOOPBACK`
// and `urlOf` from it, and headless/github-preload.ts loads that ahead of the
// script it patches (see fake-github.ts's header).

/**
 * A mirror of HUB_DEFAULT_PORT (packages/shared/src/hub.ts): the port a
 * production Hub listens on. Mirrored rather than imported because this module
 * is loaded by the preload into a baseline-tree process, where importing the
 * candidate tree's `@maxprice/shared` would load a second copy of it (and of
 * zod) ahead of the process's own. harness.test.ts pins the two equal.
 */
export const PRODUCTION_HUB_PORT = 47100;

/** The hosts treated as loopback, as a URL's `hostname` spells them. */
export const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The URL a fetch input names, as a string. */
export function urlOf(input: unknown): string {
  return input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
}

/**
 * Why a fetch of `input` is refused, or null when it may go out: only a
 * loopback host, on any port but PRODUCTION_HUB_PORT.
 */
export function offlineRefusal(input: unknown): string | null {
  const raw = urlOf(input);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `offline: ${raw}`;
  }
  if (!LOOPBACK.has(url.hostname)) return `offline: ${url.hostname}`;
  if (url.port === String(PRODUCTION_HUB_PORT)) {
    return `offline: ${url.hostname}:${url.port} is the production MaxPrice Hub's port`;
  }
  return null;
}
