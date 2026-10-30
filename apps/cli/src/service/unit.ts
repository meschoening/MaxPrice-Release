import {
  bakedEnvironment as bakedEnvironmentOf,
  execStartLine as execStartLineOf,
  unitText as unitTextOf,
  type UserUnit,
} from "@maxprice/usage-core/systemd-unit";
import { EXIT } from "../exit";
// Type-only: paths.ts imports UNIT from here.
import type { Env } from "../paths";

// The systemd user unit `maxprice service install` writes (ADR-0120 §4, with
// ADR-0122's exit 6): its text, a pure function of the command that starts
// this maxprice and the installing shell's environment and working directory.
// The text and its quoting are `@maxprice/usage-core/systemd-unit`'s, which
// the Headless Hub shares (ADR-0127 §11); this is maxprice's descriptor,
// and the core bound to it.

export const MAXPRICE_UNIT: UserUnit = {
  name: "maxprice",
  unit: "maxprice.service",
  description: "MaxPrice Headless client",
  execArgs: ["serve"],
  // The variables baked in when the installing shell sets them, since the
  // user manager never sees a shell's variables: CLAUDE_CONFIG_DIR, which the
  // watched roots follow, and XDG_DATA_HOME, which the data dir follows
  // (ADR-0120 §4 as amended by #462). An empty value counts as unset. A
  // relative CLAUDE_CONFIG_DIR entry names a dir under the shell's working
  // directory, but the unit's daemon runs in the home directory, so it is a
  // path list; a relative XDG_DATA_HOME is ignored by the daemon and by every
  // command alike, so it is baked as it is.
  baked: [{ name: "CLAUDE_CONFIG_DIR", path: "list" }, { name: "XDG_DATA_HOME" }],
  // 5: another `serve` holds the data dir; 6: its settings.json is rejected.
  lockedExit: EXIT.ALREADY_RUNNING,
  refusedExits: [
    {
      exit: EXIT.SETTINGS_REFUSED,
      note:
        "'maxprice serve' refused its settings.json, so the unit stopped without a retry; " +
        "see 'maxprice service logs'",
    },
  ],
};

export const UNIT = MAXPRICE_UNIT.unit;

export function bakedEnvironment(env: Env, cwd: string): [name: string, value: string][] {
  return bakedEnvironmentOf(MAXPRICE_UNIT, env, cwd);
}

export { environmentLine } from "@maxprice/usage-core/systemd-unit";

// ExecStart runs `command` with `serve`.
export function execStartLine(command: readonly string[]): string {
  return execStartLineOf(MAXPRICE_UNIT, command);
}

// `command` starts this maxprice: the compiled binary's absolute path, or bun
// and main.ts when run from source.
export function unitText(command: readonly string[], env: Env, cwd: string): string {
  return unitTextOf(MAXPRICE_UNIT, command, env, cwd);
}
