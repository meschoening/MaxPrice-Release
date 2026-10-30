// Reading a secret, a session key or a Hub password, one module for the
// headless products: on a terminal from a hidden prompt, otherwise all of
// stdin, and trimmed. Never from argv, which lands in shell history and `ps`.
// The Headless client's `key set` and `hub join --password` read through it
// (ADR-0121 §6.2, §8), and the Hub's `key set` (ADR-0126 §6) and `password
// set` (ADR-0128 §6) do too, rather than through a copy of their own. Each
// caller keeps its own prompts and its own words for an empty answer.
//
// Nothing here writes the value or any part of it: the prompt goes to
// stderr, a keystroke is never echoed, and the prompt's line ends with a
// bare newline.
//
// Reachable only via the "./secret-input" subpath, never index.ts.

// Ctrl-C at the prompt: the shell's code for a SIGINT (128 + 2). Raw mode
// turns Ctrl-C into a byte rather than a signal, so the command ends itself
// with it, having written nothing.
export const EXIT_INTERRUPTED = 130;

// The line being typed. `escape` is how far into an escape sequence the
// input is: ESC, a CSI (`ESC [`, up to its final byte) or an SS3 (`ESC O`
// and one byte); their bytes are dropped, so an arrow key or a bracketed
// paste's markers never join the value.
export type KeyState = {
  value: string;
  escape: "none" | "esc" | "csi" | "ss3";
  done: "enter" | "eof" | "interrupt" | null;
};

export const NO_KEYS: KeyState = { value: "", escape: "none", done: null };

// One chunk of a raw-mode terminal's input, by code point: Enter (CR or LF)
// ends the line, Backspace or DEL removes its last character, Ctrl-C
// interrupts, and Ctrl-D ends an empty line. Every other control character
// is dropped, and nothing after the line's end is read.
export function keystrokes(state: KeyState, chunk: string): KeyState {
  let { value, escape, done } = state;
  for (const char of chunk) {
    if (done !== null) break;
    if (escape === "esc") {
      escape = char === "[" ? "csi" : char === "O" ? "ss3" : "none";
      continue;
    }
    if (escape === "csi") {
      if (char >= "\x40" && char <= "\x7e") escape = "none";
      continue;
    }
    if (escape === "ss3") {
      escape = "none";
      continue;
    }
    switch (char) {
      case "\r":
      case "\n":
        done = "enter";
        break;
      case "\x03":
        done = "interrupt";
        break;
      case "\x04":
        if (value === "") done = "eof";
        break;
      case "\x7f":
      case "\b":
        value = Array.from(value).slice(0, -1).join("");
        break;
      case "\x1b":
        escape = "esc";
        break;
      default:
        if (char >= " ") value += char;
    }
  }
  return { value, escape, done };
}

export type SecretStdin = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

export type SecretSource = { stdin: SecretStdin; stderr: { write(text: string): unknown } };

async function fromPipe(stdin: SecretStdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The keystrokes until the line ends. The terminal closing ends it too, with
// what was typed.
function untilLineEnds(stdin: SecretStdin): Promise<KeyState> {
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
      state = keystrokes(state, text);
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

// The secret, trimmed, or null for Ctrl-C at the prompt. On a terminal the
// mode is restored, stdin paused and the prompt's line ended on every path,
// a read error's included.
export async function readSecret(prompt: string, source: SecretSource): Promise<string | null> {
  const { stdin, stderr } = source;
  if (stdin.isTTY !== true) return (await fromPipe(stdin)).trim();
  const setRawMode = stdin.setRawMode?.bind(stdin);
  // A terminal that cannot turn echo off would show the secret as it is
  // typed. A plain Error: each product's top level shows its message and
  // exits 1.
  if (setRawMode === undefined) {
    throw new Error("this terminal cannot hide what is typed; pipe it on stdin instead");
  }
  stderr.write(prompt);
  try {
    setRawMode(true);
    const state = await untilLineEnds(stdin);
    return state.done === "interrupt" ? null : state.value.trim();
  } finally {
    try {
      setRawMode(false);
    } finally {
      stdin.pause();
      stderr.write("\n");
    }
  }
}
