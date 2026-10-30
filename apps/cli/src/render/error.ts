import { terminalText } from "@maxprice/usage-core/terminal-text";
import { CliError } from "../exit";

// The stderr text of a failed command (ADR-0119 §7): `maxprice: ` and the
// message on one line, then a CliError's hints, each indented two spaces. A
// label/command pair pads its label to the block's longest label plus two
// spaces, so the commands line up. A message never spans lines: an error
// is one line however it was thrown, and no value inside it reaches the
// terminal as a control character (`terminalText`).

function oneLine(text: string): string {
  return terminalText(text.replace(/\s*[\r\n]+\s*/g, " ").trim());
}

export function renderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = [`maxprice: ${oneLine(message)}`];
  if (error instanceof CliError) {
    const width = Math.max(
      0,
      ...error.hints.map((hint) => (typeof hint === "string" ? 0 : oneLine(hint.label).length)),
    );
    for (const hint of error.hints) {
      lines.push(
        typeof hint === "string"
          ? `  ${oneLine(hint)}`
          : `  ${oneLine(hint.label).padEnd(width)}  ${oneLine(hint.command)}`,
      );
    }
  }
  return lines.join("\n") + "\n";
}
