import type { Env } from "../paths";

// The colour rule (#445's adopted default): colour only when stdout is a TTY,
// NO_COLOR is unset or empty (no-color.org), and TERM is not `dumb`. There is
// no --color flag.
export function colorEnabled(stream: { isTTY?: boolean }, env: Env): boolean {
  return stream.isTTY === true && !env.NO_COLOR && env.TERM !== "dumb";
}

export type Paint = (text: string) => string;
export type Style = {
  bold: Paint;
  dim: Paint;
  red: Paint;
  green: Paint;
  yellow: Paint;
  blue: Paint;
  magenta: Paint;
  cyan: Paint;
  gray: Paint;
};

const PLAIN: Paint = (text) => text;
const sgr =
  (code: string): Paint =>
  (text) =>
    `\x1b[${code}m${text}\x1b[0m`;

export function style(enabled: boolean): Style {
  if (!enabled) {
    return {
      bold: PLAIN,
      dim: PLAIN,
      red: PLAIN,
      green: PLAIN,
      yellow: PLAIN,
      blue: PLAIN,
      magenta: PLAIN,
      cyan: PLAIN,
      gray: PLAIN,
    };
  }
  return {
    bold: sgr("1"),
    dim: sgr("2"),
    red: sgr("31"),
    green: sgr("32"),
    yellow: sgr("33"),
    blue: sgr("34"),
    magenta: sgr("35"),
    cyan: sgr("36"),
    gray: sgr("90"),
  };
}
