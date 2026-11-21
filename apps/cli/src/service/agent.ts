import type { LaunchAgent } from "@maxprice/usage-core/launchd-agent";
import { EXIT } from "../exit";

// The LaunchAgent `maxprice service install` writes on macOS (ADR-0143 §4):
// maxprice's descriptor for `@maxprice/usage-core/launchd-agent`, beside the
// systemd unit's (./unit.ts). It bakes the same variables, by the same rule.

export const MAXPRICE_AGENT: LaunchAgent = {
  name: "maxprice",
  label: "com.maxprice.headless-client",
  execArgs: ["serve"],
  baked: [{ name: "CLAUDE_CONFIG_DIR", path: "list" }, { name: "XDG_DATA_HOME" }],
};

export const LABEL = MAXPRICE_AGENT.label;

// The refusals the ledger records by exit, each with the line `service
// status` prints for an agent stopped on it (ADR-0143 §5).
export const AGENT_REFUSALS = [
  {
    exit: EXIT.SETTINGS_REFUSED,
    note:
      "'maxprice serve' refused its settings.json, so the agent stopped without a retry; " +
      "see 'maxprice service logs'",
  },
] as const;
