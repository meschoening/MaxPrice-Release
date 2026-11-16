import { terminalText } from "@maxprice/usage-core/terminal-text";
import { CliError, EXIT, type Writer } from "./cli";

// What `maxprice-hub key` and `gateway` print with, and `status --json`:
// their lines and tables through `terminalText` (ADR-0127 §11), since a path
// the environment names, a label, a machine id and a Gateway's host all come
// from outside this process, and their `--json` objects through
// `terminalJson`. Their own refusal off Linux is here too.

// One line of output.
export function say(out: Writer, line: string): void {
  out.write(`${terminalText(line)}\n`);
}

// ADR-0126 §9, ADR-0141 §7: the keys' file and the operator token are
// Linux's; elsewhere the Hub keeps its keys in the keychain and its console
// sets them. `elsewhere` names what to do there.
export function linuxOnly(platform: NodeJS.Platform, elsewhere: string): void {
  if (platform !== "linux") throw new CliError(EXIT.USAGE, `Linux only; ${elsewhere}`);
}

// An empty cell.
export const DASH = "—";

// A table: its header row, then one row per entry, each cell through
// `terminalText` before it is measured, the columns two spaces apart and the
// last one unpadded.
export function terminalTable(
  header: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): string {
  const all = [header, ...rows].map((row) => row.map(terminalText));
  const width = (text: string) => Array.from(text).length;
  const widths = all[0]!.map((_, i) => Math.max(...all.map((row) => width(row[i]!))));
  return all
    .map((row) =>
      row
        .map((cell, i) =>
          i === row.length - 1 ? cell : cell + " ".repeat(widths[i]! - width(cell) + 2),
        )
        .join(""),
    )
    .join("\n")
    .concat("\n");
}

// A `--json` object (`status`, `key list`, `gateway list`) as JSON.stringify
// writes it, which already escapes every C0 control character. DEL, C1 and
// the two Unicode line separators it leaves raw are escaped too, so no value
// can act on a terminal: JSON reads each `\u` escape back as the character
// it names, so the object parses to the same values. Not `terminalText`,
// which would change them.
export function terminalJson(value: unknown): string {
  return (
    JSON.stringify(value).replace(
      /[\u007f-\u009f\u2028\u2029]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ) + "\n"
  );
}
