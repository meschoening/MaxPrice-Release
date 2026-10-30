import { unitDataDir as unitDataDirOf } from "@maxprice/usage-core/systemctl";
import { dataDir, type Env } from "../paths";

// The systemd tools `maxprice update` runs, and what it reads from their
// output: `@maxprice/usage-core/systemctl`'s, which the Headless Hub
// shares (ADR-0127 §11), with the unit's data dir read by maxprice's own rule.
// `service` uses the module directly; these are the parts `update` and this
// directory's tests import.

export {
  describeExit,
  locate,
  parseEnvironment,
  parseExecStart,
  parseProperties,
  property,
  reason,
  runTool,
  type Tool,
} from "@maxprice/usage-core/systemctl";

// The data dir the unit's daemon serves, from its `Environment` property: its
// own XDG_DATA_HOME, or the default, under this user's home. `update` waits
// on its socket.
export function unitDataDir(properties: Map<string, string[]>, env: Env): string {
  return unitDataDirOf(dataDir, properties, env);
}
