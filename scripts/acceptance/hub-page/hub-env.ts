// The environment and paths of a sandboxed compiled Headless Hub (#493), pure,
// so the host rigs and the peers rig's probe (compiled into it, run inside a
// Docker network namespace) build one the same way: hub-sandbox.ts says why.
import { isAbsolute, join } from "node:path";

/**
 * The HTTPS proxy every sandboxed Hub runs behind: a closed loopback port, so
 * the boot update check of a compiled production binary is refused on loopback
 * (hubEnv says why).
 */
export const DEAD_HTTPS_PROXY = "http://127.0.0.1:9";

/** The name the binary's copy runs under. */
export const HUB_COPY_NAME = "maxprice-hub";

export interface SandboxPaths {
  readonly root: string;
  /** The directory holding the binary's copy and nothing else. */
  readonly bin: string;
  readonly binary: string;
  readonly home: string;
  readonly config: string;
  readonly data: string;
  /** MAXPRICE_HUB_DATA_DIR: hub.json and every file the Hub writes. */
  readonly hubData: string;
}

export function sandboxPaths(root: string): SandboxPaths {
  const bin = join(root, "bin");
  return {
    root,
    bin,
    binary: join(bin, HUB_COPY_NAME),
    home: join(root, "home"),
    config: join(root, "config"),
    data: join(root, "data"),
    hubData: join(root, "hub-data"),
  };
}

export interface HubEnvInput {
  readonly path: string;
  /** The sandbox's root: every directory the Hub is told of is inside it. */
  readonly root: string;
  /** The fake claude.ai's base URL, `/api` included. */
  readonly claudeBaseUrl: string;
  readonly embedded?: boolean;
}

/**
 * A sandboxed Hub's whole environment. Throws on a relative root or a
 * claude.ai base that is not plain HTTP on a loopback address: the Hub must
 * never be pointed at the real claude.ai.
 */
export function hubEnv(input: HubEnvInput): Record<string, string> {
  if (!isAbsolute(input.root)) throw new Error(`hubEnv: the root ${input.root} is not absolute`);
  let base: URL;
  try {
    base = new URL(input.claudeBaseUrl);
  } catch {
    throw new Error(`hubEnv: ${input.claudeBaseUrl} is not a URL`);
  }
  if (base.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(base.hostname)) {
    throw new Error(`hubEnv: the claude.ai base ${input.claudeBaseUrl} is not loopback HTTP`);
  }
  const paths = sandboxPaths(input.root);
  return {
    PATH: input.path,
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    MAXPRICE_HUB_DATA_DIR: paths.hubData,
    MAXPRICE_CLAUDE_BASE_URL: input.claudeBaseUrl,
    // A Headless Hub on Linux checks its update channel at boot (ADR-0129
    // §6). A compiled production binary asks the real one on GitHub, over
    // HTTPS, with no preload in front of it: this unroutable proxy refuses
    // that request on loopback. The claude.ai base (above) and a test build's
    // channel are plain-HTTP loopback, which HTTPS_PROXY does not touch.
    HTTPS_PROXY: DEAD_HTTPS_PROXY,
    ...(input.embedded === true ? { MAXPRICE_HUB_EMBEDDED: "1" } : {}),
  };
}

/** hub.json as the rigs write it: one port, one bind, no password. */
export function hubConfig(
  port: number,
  bind: string,
): { port: number; bind: string; passwordHash: null } {
  return { port, bind, passwordHash: null };
}

export const REDACTED = "<redacted>";

/**
 * The text with each operator secret an embedded Hub printed
 * (`OPERATOR_TOKEN <secret>`, ADR-0037) replaced by REDACTED, wherever the
 * secret appears.
 */
export function redactOperatorToken(text: string): string {
  const secrets = [...text.matchAll(/^OPERATOR_TOKEN (\S+)\r?$/gm)].map((m) => m[1]!);
  let out = text;
  for (const secret of new Set(secrets)) out = out.split(secret).join(REDACTED);
  return out;
}
