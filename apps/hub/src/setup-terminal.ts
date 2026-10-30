import {
  keystrokes,
  type KeyState,
  NO_KEYS,
  readSecret,
  type SecretStdin,
} from "@maxprice/usage-core/secret-input";
import type { Writer } from "./cli";

// Setup's prompts (ADR-0128 §3), all on stdout: the visible answers it asks
// for, a [y/N] or a Hub page URL, a line at a time, and the two secrets, the
// claude.ai session key and the Hub password, through readSecret, as `key
// set` and `password set` read them (§6), never through a copy of it. Setup
// gates on stdin being a terminal (§1), so neither is ever handed a pipe.
//
// A visible answer is read in raw mode, setup echoing the line itself, and
// not in the terminal's cooked mode: raw mode makes Ctrl-C a byte rather
// than a SIGINT, so Ctrl-C at any prompt answers null, and setup ends itself
// with exit 130, EXIT_INTERRUPTED, as `key set` and `password set` do,
// keeping every step it completed (§3). The keystrokes are secret-input's,
// so Enter, Backspace, Ctrl-D and an arrow key's or a bracketed paste's
// escape sequences mean the same at every prompt, hidden or not.
//
// `line` shows what is typed: never read a secret with it.

export type SetupTerminal = {
  // The answer, trimmed, or null for Ctrl-C, for Ctrl-D on an empty line,
  // and for the terminal closing.
  line(prompt: string): Promise<string | null>;
  // readSecret's answer: trimmed, or null for Ctrl-C. Nothing is echoed.
  secret(prompt: string): Promise<string | null>;
};

// What turns the line on screen from `before` into `after`: an erase for
// each character `after` dropped, then each it added. A chunk's keystrokes
// only append to the line or remove its last character, so this is the
// net of what was typed; an escape sequence or another control character
// changes nothing and shows nothing.
function echo(before: string, after: string): string {
  const shown = Array.from(before);
  const typed = Array.from(after);
  let kept = 0;
  while (kept < shown.length && kept < typed.length && shown[kept] === typed[kept]) kept++;
  return "\b \b".repeat(shown.length - kept) + typed.slice(kept).join("");
}

// The keystrokes until the line ends, each chunk's echoed as it arrives.
// The terminal closing ends the line as Ctrl-D does.
function echoedLine(stdin: SecretStdin, out: Writer): Promise<KeyState> {
  const decoder = new TextDecoder();
  let state = NO_KEYS;
  return new Promise((resolve, reject) => {
    const finish = (settle: () => void) => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
      settle();
    };
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const next = keystrokes(state, text);
      const shown = echo(state.value, next.value);
      if (shown !== "") out.write(shown);
      state = next;
      if (state.done !== null) finish(() => resolve(state));
    };
    const onEnd = () => finish(() => resolve({ ...state, done: "eof" }));
    const onError = (error: Error) => finish(() => reject(error));
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
    stdin.resume();
  });
}

// Setup's terminal over `stdin`, writing every prompt to `out`. Each read
// restores the mode, pauses stdin and ends the prompt's line on every path,
// a read error's included, as readSecret does.
export function createSetupTerminal({
  stdin,
  out,
}: {
  stdin: SecretStdin;
  out: Writer;
}): SetupTerminal {
  return {
    async line(prompt) {
      const setRawMode = stdin.setRawMode?.bind(stdin);
      // A plain Error, as readSecret's refusal is: the top level shows its
      // message and exits 1.
      if (setRawMode === undefined) {
        throw new Error("this terminal has no raw mode; setup needs a terminal");
      }
      out.write(prompt);
      try {
        setRawMode(true);
        const state = await echoedLine(stdin, out);
        return state.done === "enter" ? state.value.trim() : null;
      } finally {
        try {
          setRawMode(false);
        } finally {
          stdin.pause();
          out.write("\n");
        }
      }
    },
    secret: (prompt) => readSecret(prompt, { stdin, stderr: out }),
  };
}
