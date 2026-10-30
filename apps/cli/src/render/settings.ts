import { DEFAULT_CLAUDE_PATHS, parseSettings } from "@maxprice/shared";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import { rejectedFields } from "../settings";
import type { SettingKey } from "../settings-keys";
import type { Style } from "./style";
import { type Column, type Output, renderTable } from "./table";

// `maxprice settings get` as #445's Variant A table: one row per setting,
// with the value that applies and where it comes from, then a line for each
// rejected one (ADR-0122 §7). Pure: the command reads the file.
//
//   Settings · ~/.local/share/maxprice/settings.json
//   ┌───────────┬───────┬──────────┐
//   │ Setting   │ Value │ Source   │
//   ├───────────┼───────┼──────────┤
//   │ cost-mode │ auto  │ rejected │
//   └───────────┴───────┴──────────┘
//   cost-mode: stored value rejected, using auto

export type SettingsView = {
  // settings.json, already as a message shows it.
  path: string;
  // The file's JSON object as read.
  raw: Record<string, unknown>;
  // The rows, in order: all seven, or the one `get` named.
  keys: readonly SettingKey[];
};

// `set`: the file holds a value the setting takes. `default`: the file holds
// none. `rejected`: it holds one the setting does not take, and the schema's
// fallback applies.
type Source = "set" | "default" | "rejected";

type Row = { name: string; value: string; source: Source };

// ADR-0122 §5: with no `claudePaths` in the file, the daemon watches the
// `projects` dir of each `$CLAUDE_CONFIG_DIR` entry, and only without one
// the two standard paths (`resolveWatchRoots`). A
// rejected value is not absent: the schema's default, those two paths,
// applies to it.
const ABSENT_CLAUDE_PATHS = `$CLAUDE_CONFIG_DIR/projects, else ${DEFAULT_CLAUDE_PATHS.join(", ")}`;

function paintSource(text: string, s: Style): string {
  if (text === "rejected") return s.yellow(text);
  if (text === "default") return s.dim(text);
  return text;
}

const COLUMNS: readonly Column<Row>[] = [
  { header: "Setting", text: (row) => row.name },
  // A name column (#445): a narrow terminal cuts a long path list here.
  { header: "Value", text: (row) => row.value, min: 20 },
  { header: "Source", text: (row) => row.source, paint: paintSource },
];

export function renderSettings(view: SettingsView, out: Output): string {
  const settings = parseSettings(view.raw);
  const rejected = new Set(rejectedFields(view.raw).map((field) => field.file));
  const rows = view.keys.map((key): Row => {
    if (!Object.hasOwn(view.raw, key.file)) {
      const value = key.file === "claudePaths" ? ABSENT_CLAUDE_PATHS : key.format(settings);
      return { name: key.name, value, source: "default" };
    }
    const source = rejected.has(key.file) ? "rejected" : "set";
    return { name: key.name, value: key.format(settings), source };
  });
  const table = renderTable({ title: `Settings · ${view.path}`, columns: COLUMNS, rows }, out);
  // ADR-0122 §7's wording. What applies is the schema's, but the line is
  // made inert all the same, as every value in the table is.
  const notes = rows
    .filter((row) => row.source === "rejected")
    .map((row) =>
      out.style.yellow(terminalText(`${row.name}: stored value rejected, using ${row.value}`)),
    );
  return table + notes.map((note) => `${note}\n`).join("");
}
