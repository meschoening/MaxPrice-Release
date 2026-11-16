import type { Settings } from "@maxprice/shared";

// "Send keys to the Hub" (`hubAutoHeal`, ADR-0035, per key since ADR-0138 §7):
// while joined to a Hub, this machine sends the Hub any key it holds for an
// Account the Hub holds no working key for. One helper behind both switches,
// Settings › Accounts' hub strip and the Usage hub section (#639): it persists
// the setting, then, with a Hub configured, re-pushes the hub config with the
// stored password and the new value, so the running sidecar starts (or stops)
// sending at once. A stored password that is corrupted rejects after the
// setting stands, so the caller shows the re-entry error rather than an opaque
// "unreachable" (F18). With no Hub it persists only: the sidecar reads the
// value with the next hub config it is pushed.

export interface HubAutoHealDeps {
  // The persisted Hub URL (`settings.hubUrl`); empty with no Hub.
  hubUrl: string;
  update: (patch: Pick<Settings, "hubAutoHeal">) => Promise<void>;
  // The keychain's Hub password, validated (`readStoredHubPassword`).
  readPassword: () => Promise<string | null>;
  // `pushHubConfigToSidecar`.
  push: (url: string, password: string | null, autoHeal: boolean) => Promise<void>;
}

export async function applyHubAutoHeal(next: boolean, deps: HubAutoHealDeps): Promise<void> {
  await deps.update({ hubAutoHeal: next });
  const url = deps.hubUrl.trim();
  if (url === "") return;
  const password = await deps.readPassword();
  await deps.push(url, password, next);
}
