import {
  hubCompactResponseSchema,
  hubMachinesResponseSchema,
  isValidHubPassword,
} from "@maxprice/shared";
import { readSecret } from "@maxprice/usage-core/secret-input";
import { CliError, EXIT, type Io } from "./cli";
import { type HubAnswer, refusal, type RunningHub, unreadable } from "./operator-client";
import { cleanRenameName } from "./server";

// The operator commands' side of a running Hub (ADR-0127 §7): the live twin
// of each command that edits a Hub's data, which runOperatorVerb (index.ts)
// calls once reachHub finds a daemon holding serve.lock; `password set`'s
// input, a secret read before the Hub is reached, and the reader `key set`
// shares (key-commands.ts).
//
// A live twin calls the route the console calls (hub-desktop's hub-api.ts),
// so the daemon performs those commands' writes and applies each change at
// once, with no restart. Page commands write config separately, serialized
// with the daemon's config writes by config.ts. A store verb's refusal is
// exit 2 on both paths, in the route's words, which are the offline edit's
// but for a rename's collision, where the route names the name already in
// use as it is written. The password commands' refusals are exit 1, as `key
// set`'s are (key-commands.ts). Each live twin returns its success line;
// every refusal throws a CliError.

const MACHINES_PATH = "/api/machines";
const COMPACT_PATH = "/api/store/compact";
const PASSWORD_PATH = "/api/password";

function machinePath(machineId: string): string {
  return `${MACHINES_PATH}/${encodeURIComponent(machineId)}`;
}

// A store route's refusal, exit 2. Rename's and purge's routes answer a bare
// "unknown machine"; the offline edit names it, so this does too.
function storeRefusal(answer: HubAnswer, path: string, machineId?: string): CliError {
  if (answer.status === 404 && machineId !== undefined) {
    return new CliError(EXIT.USAGE, `unknown machine: ${machineId}`);
  }
  return new CliError(EXIT.USAGE, refusal(answer, path));
}

// `rename`, as the console's Rename: the name is trimmed and checked here,
// by the route's own rule, so an invalid one sends nothing.
export async function liveRenameMachine(
  hub: RunningHub,
  machineId: string,
  name: string,
): Promise<string> {
  const trimmed = cleanRenameName(name);
  if (trimmed === null) throw new CliError(EXIT.USAGE, "invalid name (1-63 chars)");
  const path = `${machinePath(machineId)}/name`;
  const answer = await hub.request("POST", path, { name: trimmed });
  if (!answer.ok) throw storeRefusal(answer, path, machineId);
  return `renamed ${machineId} to "${trimmed}"`;
}

// `merge`, as the console's Merge. The route's refusals name the machine
// itself (`unknown machine: X`, `cannot merge a machine into itself`, `merge
// would create an alias cycle`), as the offline edit does.
export async function liveMergeMachine(
  hub: RunningHub,
  sourceId: string,
  targetId: string,
): Promise<string> {
  const path = `${machinePath(sourceId)}/merge`;
  const answer = await hub.request("POST", path, { into: targetId });
  if (!answer.ok) throw storeRefusal(answer, path);
  return `merged ${sourceId} into ${targetId} (alias only — no events rewritten)`;
}

// `purge-machine`, as the console's Purge: the machine's name comes from the
// running Hub's Machine directory, and nothing is sent until it is typed. The
// route returns no count, and the listing's may be stale by the time the
// purge lands, so the line gives none.
export async function livePurgeMachine(
  hub: RunningHub,
  machineId: string,
  confirmName: (expected: string) => boolean,
): Promise<string> {
  const listing = await hub.request("GET", MACHINES_PATH);
  if (!listing.ok) throw storeRefusal(listing, MACHINES_PATH);
  const parsed = hubMachinesResponseSchema.safeParse(listing.body);
  if (!parsed.success) throw unreadable(MACHINES_PATH);
  const entry = parsed.data.machines.find((machine) => machine.machineId === machineId);
  if (entry === undefined) throw new CliError(EXIT.USAGE, `unknown machine: ${machineId}`);
  if (!confirmName(entry.name)) {
    throw new CliError(EXIT.USAGE, "confirmation did not match - aborted");
  }
  const path = machinePath(machineId);
  const answer = await hub.request("DELETE", path, { operationId: crypto.randomUUID() });
  if (!answer.ok) throw storeRefusal(answer, path, machineId);
  return `purged "${entry.name}" (${machineId}); clients receive an incremental deletion`;
}

// `compact`, as the console's Compact.
export async function liveCompact(hub: RunningHub): Promise<string> {
  const answer = await hub.request("POST", COMPACT_PATH);
  if (!answer.ok) throw storeRefusal(answer, COMPACT_PATH);
  const parsed = hubCompactResponseSchema.safeParse(answer.body);
  if (!parsed.success) throw unreadable(COMPACT_PATH);
  return `compacted: ${parsed.data.freedBytes} bytes reclaimed; usage and incremental history preserved`;
}

// `password set|clear` through the route the console's Access card uses
// (ADR-0037): the daemon hashes and persists it and swaps its gate at once.
// The route's refusals are fixed words and never quote the password.
async function postPassword(hub: RunningHub, password: string | null): Promise<void> {
  const answer = await hub.request("POST", PASSWORD_PATH, { password });
  if (!answer.ok) {
    throw new CliError(
      EXIT.FAILURE,
      `the running Hub refused the password: ${refusal(answer, PASSWORD_PATH)}`,
    );
  }
}

export async function livePasswordSet(hub: RunningHub, password: string): Promise<string> {
  await postPassword(hub, password);
  return "password set — the running Hub applies it at once";
}

export async function livePasswordClear(hub: RunningHub): Promise<string> {
  await postPassword(hub, null);
  return "password cleared — the running Hub applies it at once";
}

export type ReadSecret = (prompt: string) => Promise<string | null>;

// What the secret-reading commands take from a test; production passes none.
export type SecretDeps = {
  // In place of the real stdin: the value, or null for Ctrl-C.
  readSecret?: ReadSecret;
  // Whether stdin is a terminal, which asks for a password twice, and has
  // `key set` ask for the Account's label.
  interactive?: boolean;
};

// The reader `password set` and `key set` read their secret with.
export function secretReader(deps: SecretDeps, io?: Io): ReadSecret {
  return (
    deps.readSecret ??
    ((prompt) => readSecret(prompt, { stdin: process.stdin, stderr: io?.stderr ?? process.stderr }))
  );
}

// `password set`'s input (ADR-0128 §6), as `key set` reads the key: on a
// terminal a hidden prompt asked twice, else all of stdin, trimmed; never
// argv, which cli.ts refuses. The rule is checked after the first entry, so
// an invalid password is not typed twice. null is Ctrl-C at either prompt,
// which the caller ends with exit 130, having written nothing. No message
// here quotes what was typed.
export async function readNewPassword(deps: SecretDeps = {}): Promise<string | null> {
  const read = secretReader(deps);
  const interactive = deps.interactive ?? process.stdin.isTTY === true;
  const password = await read("New Hub password: ");
  if (password === null) return null;
  if (password === "") throw new CliError(EXIT.USAGE, "no password was given");
  if (!isValidHubPassword(password)) {
    throw new CliError(EXIT.USAGE, "invalid password: printable ASCII, no spaces, 1-128 chars");
  }
  if (interactive) {
    const again = await read("Again: ");
    if (again === null) return null;
    if (again !== password) {
      throw new CliError(EXIT.FAILURE, "the two entries did not match; nothing was written");
    }
  }
  return password;
}
