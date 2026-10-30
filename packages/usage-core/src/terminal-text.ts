// Text from outside this process (an Organization label, a model name, a
// path, a URL, an error's detail, the user manager's answers) reaches a
// headless product's terminal only through here, the Headless client's and
// the Headless Hub's alike (ADR-0127 §11). A line break or tab folds to one
// space, so a row stays one line, and every other control character prints
// as its `\u` escape, so an escape sequence inside a value can neither paint
// past the colour rule nor move the cursor. Apply it to the value before any
// paint; `--json` output never comes here.
//
// Reachable only via the "./terminal-text" subpath, never index.ts.

// C0, DEL and C1.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

export function terminalText(text: string): string {
  return text
    .replace(/[\t\n\v\f\r\u2028\u2029]+/g, " ")
    .replace(CONTROL, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
