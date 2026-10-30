import { readFileSync } from "node:fs";
import { parseSettings } from "@maxprice/shared";
import { displayHubUrl } from "./hub-url";
import { desktopSettingsPath, type Env } from "./paths";

// The double-join warning (ADR-0120 §6). A Desktop client and a Headless
// client on one machine that both join a Hub do not double-count, but this
// machine's usage splits between two Machine directory entries. The Headless
// client cannot tell whether the Desktop client's Hub is its own, so it warns
// whenever the Desktop client's settings.json names any Hub, and never blocks.
// `serve` logs it once at boot and `status` shows it as a line; `hub join`
// will show it too.

// The Desktop client's `hubUrl`, or null when it names none or its settings
// cannot be read.
export function desktopHubUrl(env: Env): string | null {
  let raw: string;
  try {
    raw = readFileSync(desktopSettingsPath(env), "utf8");
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const url = parseSettings(json).hubUrl.trim();
  return url === "" ? null : url;
}

// Redact here so every consumer hides Desktop URL userinfo and invalid text.
export function doubleJoinWarning(url: string): string {
  return (
    `the Desktop client on this machine is also joined to ${displayHubUrl(url)}; ` +
    "if that is this Hub, this machine's usage splits across two machine entries"
  );
}
