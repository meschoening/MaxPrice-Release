import { createInterface } from "node:readline";
import {
  checkLabel,
  excludeCopy,
  isExcludeArmed,
  LABEL_MAX,
  parseSettings,
  type Settings,
} from "@maxprice/shared";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import type { ZodType, ZodTypeDef } from "zod";
import { connect, type Daemon, waitForStatus } from "./daemon-client";
import { CliError, EXIT, usageError } from "./exit";
import type { Io } from "./main";
import { dataDir, displayPath, type Env, settingsPath } from "./paths";
import { admissionRejection, editSettings, type EditOptions, readSettingsObject } from "./settings";

// What `org`, `account` and `home` share (ADR-0122 §6, ADR-0140 §5): the
// terminal's Settings › Accounts. Each verb connects first (a down daemon
// exits 3, a skewed one 4, before the file is read) and waits out the
// initial scan; an edit reads its guards from the file, asks before an
// exclude, writes under the settings lock, and then waits for the daemon to
// show it. A label goes through the daemon's own rename route.

// What a test replaces; production passes none.
export type EditDeps = {
  edit?: EditOptions;
  // Whether stdin is a terminal, where `exclude` asks for the label.
  stdinIsTTY?: boolean;
  // Asks on the terminal and reads one line; null at the end of input.
  readLine?: (prompt: string) => Promise<string | null>;
};

// How often a wait reads the daemon (ADR-0122 §6).
const POLL_MS = 100;

// Home and the tracked lists as the file holds them. A value the schema
// rejects is refused, not read as its fallback: a patch built on the
// fallback would replace the stored value (ADR-0122 §7).
export function trackingSettings(raw: Record<string, unknown>, env: Env): Settings {
  const rejection = admissionRejection(raw, env);
  if (rejection !== null) throw new CliError(EXIT.FAILURE, `${rejection}; fix the file`);
  return parseSettings(raw);
}

// The daemon, once the initial scan is done: during it, the rosters of a
// machine with a persisted Home are partial lists.
export async function readyDaemon(io: Io, env: Env): Promise<Daemon> {
  const daemon = await connect({ env });
  if (!daemon.status.ready) await waitForStatus(daemon, "ready", "scanning…", io.stderr);
  return daemon;
}

export async function read<T>(
  daemon: Daemon,
  path: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
): Promise<T> {
  return (await daemon.request(path, schema)).data;
}

// One line from the terminal, the prompt on stderr; null at the end of
// input. Line mode, not readline's raw one: the terminal echoes and edits
// the line, and Ctrl-C is the ordinary SIGINT. Closed once answered, so
// stdin holds the process open no longer.
function readTerminalLine(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
    let answered = false;
    rl.on("close", () => {
      if (!answered) resolve(null);
    });
    rl.question(prompt, (line) => {
      answered = true;
      rl.close();
      resolve(line);
    });
  });
}

// One answer from the terminal, as `readTerminalLine` reads it, but Ctrl-C
// answers null instead of ending the process, so the command stops itself
// with exit 130 having written nothing more: `key set`'s Track prompts
// (ADR-0140 §7), which come after the key is stored. Ctrl-D, or the
// terminal closing, answers null too.
export function readInterruptibleLine(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
    let settled = false;
    const finish = (answer: string | null) => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", onInterrupt);
      rl.close();
      resolve(answer);
    };
    const onInterrupt = () => {
      process.stderr.write("\n");
      finish(null);
    };
    process.on("SIGINT", onInterrupt);
    rl.on("close", () => finish(null));
    rl.question(prompt, (line) => finish(line));
  });
}

// ADR-0122 §6: the Desktop client's question (`title`, then its Hub-aware
// `excludeCopy`), on stderr, then the bare label, from `--confirm` or typed
// on a terminal; there is no blanket `--yes`. A label that does not match
// exits 1 before anything is locked or written.
export async function confirmExclude(args: {
  title: string;
  bareLabel: string;
  confirm: string | undefined;
  help: string;
  daemon: Daemon;
  io: Io;
  deps: EditDeps;
}): Promise<void> {
  const { bareLabel, confirm, daemon, io, deps } = args;
  // A Hub configured, connected or not, is told its sessions leave it.
  const copy = excludeCopy({ hub: daemon.status.hubConnection !== "off" });
  io.stderr.write([terminalText(args.title), ...copy].join("\n\n") + "\n");
  let typed: string | null;
  if (confirm !== undefined) {
    typed = confirm;
  } else if (deps.stdinIsTTY ?? process.stdin.isTTY === true) {
    io.stderr.write("\n");
    typed = await (deps.readLine ?? readTerminalLine)(
      `Type ${terminalText(bareLabel)} to exclude it: `,
    );
  } else {
    throw usageError("exclude needs --confirm <label> when not on a terminal", args.help);
  }
  if (typed === null || !isExcludeArmed(typed, bareLabel)) {
    throw new CliError(EXIT.FAILURE, "the label does not match; nothing was excluded");
  }
}

// The wait, after the write: a failure keeps its code and its hints, plus
// where the change is, as `settings set`'s probe does. A daemon gone
// mid-wait exits 3 with the change already in the file, and applies it when
// it starts.
async function sayWhereSavedOnFailure<T>(env: Env, wait: () => Promise<T>): Promise<T> {
  try {
    return await wait();
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    const path = displayPath(settingsPath(dataDir(env)), env);
    throw new CliError(error.code, error.message, [
      ...error.hints,
      `The change is saved in ${path}.`,
    ]);
  }
}

// The line a wait prints when a later change replaced this one in the file,
// so the daemon may never show it.
const REPLACED_NOTE = "maxprice: a later change replaced this one; not waiting for it\n";

// What an edit comes to against the settings it is built from: a patch to
// write; or nothing to write, which is either a line on stdout and exit 0,
// or exit 1.
export type Decision<P> =
  | { kind: "write"; patch: P }
  | { kind: "answer"; line: string }
  | { kind: "refuse"; error: CliError };

// A decision with nothing to write: its line and exit 0, or its error.
export function settle(decision: Exclude<Decision<unknown>, { kind: "write" }>, io: Io): number {
  if (decision.kind === "refuse") throw decision.error;
  io.stdout.write(`${decision.line}\n`);
  return EXIT.OK;
}

// How a wait watches for an edit: `read` reads the daemon's state, in which
// `rewalking` says whether an Organization is re-walking and `shows` whether
// the daemon shows the edit; `holds` says whether the file still holds it.
export type Watch<S> = {
  read: () => Promise<S>;
  rewalking: (state: S) => boolean;
  shows: (state: S) => boolean;
  holds: (settings: Settings) => boolean;
};

// ADR-0122 §6, after the write: until the daemon shows the edit and no
// Organization is re-walking, with no deadline; Ctrl-C ends the wait, and
// the daemon finishes on its own. It does not wait for the repair's Hub
// forget, which retries on its own timer. Once the file no longer holds the
// edit, a later one replaced it, and the daemon may never show it: a line
// says so, and the wait ends. A failure says where the change is
// (`sayWhereSavedOnFailure`).
export async function waitForEdit<S>(watch: Watch<S>, io: Io, env: Env): Promise<void> {
  await sayWhereSavedOnFailure(env, async () => {
    let rewalked = false;
    for (;;) {
      const state = await watch.read();
      const rewalking = watch.rewalking(state);
      if (rewalking && !rewalked) {
        rewalked = true;
        if (io.stderr.isTTY) io.stderr.write("re-walking…\n");
      }
      if (!rewalking && watch.shows(state)) return;
      // Read through the guards' refusal: a Home or tracked list the schema
      // rejects exits 1, where its fallback could pass for a replaced edit.
      if (!watch.holds(trackingSettings(readSettingsObject(env), env))) {
        io.stderr.write(REPLACED_NOTE);
        return;
      }
      await Bun.sleep(POLL_MS);
    }
  });
}

// One edit of the tracking settings, end to end: `decide` against the file
// as it is now (or as `first`, when the caller has already read it), where
// an answer needs no question and no lock; then `confirm`, when given (an
// exclude's question); then decided again from the file as read under the
// settings lock, so an edit another `maxprice` made meanwhile is built on,
// not undone, and `apply` writes the patch into it; then the wait. An edit
// made meanwhile can leave nothing to write, and the answer is then the
// locked read's, not the first one's. Returns the settings the write was
// built on, or null when it settled with an answer.
export async function editAndWait<P, S>(
  edit: {
    first?: Settings;
    decide: (settings: Settings) => Decision<P>;
    confirm?: () => Promise<void>;
    apply: (raw: Record<string, unknown>, patch: P) => void;
    watch: Watch<S>;
  },
  io: Io,
  env: Env,
  deps: EditDeps,
): Promise<Settings | null> {
  const first = edit.decide(edit.first ?? trackingSettings(readSettingsObject(env), env));
  if (first.kind !== "write") {
    settle(first, io);
    return null;
  }
  await edit.confirm?.();
  let decision = first as Decision<P>;
  let before = null as Settings | null;
  await editSettings(
    env,
    (raw) => {
      before = trackingSettings(raw, env);
      decision = edit.decide(before);
      if (decision.kind !== "write") return false;
      edit.apply(raw, decision.patch);
      return true;
    },
    deps.edit,
  );
  if (decision.kind !== "write") {
    settle(decision, io);
    return null;
  }
  await waitForEdit(edit.watch, io, env);
  return before;
}

// `<command> label <name> <label>` or `<command> label <name> --unset`
// (ADR-0140 §5): the name and the label to send, null to remove it. A label
// is checked by the daemon's own rule (`checkLabel`) first, so an empty or
// overlong one exits 2 before anything is asked.
export function labelArguments(
  names: readonly string[],
  unset: boolean,
  command: string,
  noun: string,
  help: string,
): { name: string; label: string | null } {
  const usage = (message: string) => usageError(message, help);
  if (names.length === 0) throw usage(`${command} label needs an ${noun}`);
  if (unset) {
    if (names.length > 1) throw usage(`${command} label --unset takes no label`);
    return { name: names[0]!, label: null };
  }
  if (names.length === 1) throw usage(`${command} label needs a label, or --unset`);
  if (names.length > 2) throw usage(`${command} label takes one ${noun} and one label`);
  const check = checkLabel(names[1]!);
  if (!check.ok) {
    throw usage(
      check.reason === "empty"
        ? "the label is empty"
        : `the label is longer than ${LABEL_MAX} characters`,
    );
  }
  return { name: names[0]!, label: check.label };
}

// A label's PUT, its refusal (a label another one already shows, a full
// Label directory, a target the route does not take) said for the thing
// named. A daemon that is down or skewed keeps its own code and words.
export async function putLabel<T>(
  daemon: Daemon,
  path: string,
  label: string | null,
  schema: ZodType<T, ZodTypeDef, unknown>,
  name: string,
): Promise<T> {
  try {
    return (await daemon.request(path, schema, { method: "PUT", body: { label } })).data;
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== EXIT.FAILURE) throw error;
    throw new CliError(EXIT.FAILURE, `cannot label ${name}: ${error.message}`, error.hints);
  }
}

// What a label edit changed, in one line: `<old name> is now <label>`, or
// that it already was. Inert, since a label is the user's.
export function labelOutcome(oldName: string, label: string, oldLabel: string): string {
  const shown = terminalText(label);
  return label === oldLabel ? `${oldName} is already ${shown}` : `${oldName} is now ${shown}`;
}
