// A child process the real-route rigs read as it runs (#493): served.ts's Hub
// on the host and peers-probe.ts's Hub inside a container (compiled into the
// probe, as hub-env.ts and raw-http.ts are) start, drain, wait for boot lines
// and stop the same way.

/** The lines of `lines` that are not yet a whole line of `text`. */
export function missingLines(text: string, lines: readonly string[]): string[] {
  const whole = new Set(text.split("\n").map((line) => line.replace(/\r$/, "")));
  return lines.filter((line) => !whole.has(line));
}

export interface Spawned {
  readonly proc: Bun.Subprocess;
  /** Everything it has written to stdout so far, and to stderr. */
  stdout(): string;
  stderr(): string;
  /** Its exit code, or null while it runs. */
  exitCode(): number | null;
  /** Settles once it has exited and both streams are drained. */
  readonly drained: Promise<void>;
  /**
   * Waits until each of `lines` is a whole stdout line, it exits, or
   * `timeoutMs` passes; resolves with the lines still missing.
   */
  waitForLines(lines: readonly string[], timeoutMs: number): Promise<string[]>;
  /**
   * SIGTERM, or closing its stdin when `viaStdin` and it has one; SIGKILL
   * after `killAfterMs` (10 s unless given). Resolves with its exit code once
   * drained. A process that has already exited is only drained.
   */
  stop(options?: { viaStdin?: boolean; killAfterMs?: number }): Promise<number | null>;
}

/** Starts `argv` with both output streams drained into strings as they come. */
export function spawnDrained(
  argv: readonly string[],
  options: { cwd: string; env: Record<string, string>; stdin: "pipe" | "ignore" },
): Spawned {
  const proc = Bun.spawn([...argv], {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = { stdout: "", stderr: "" };
  const drain = async (stream: ReadableStream<Uint8Array>, key: "stdout" | "stderr") => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) text[key] += decoder.decode(chunk, { stream: true });
  };
  let exitCode: number | null = null;
  const exited = proc.exited.then((code) => {
    exitCode = code;
  });
  const drained = Promise.all([
    drain(proc.stdout, "stdout"),
    drain(proc.stderr, "stderr"),
    exited,
  ]).then(() => undefined);
  return {
    proc,
    stdout: () => text.stdout,
    stderr: () => text.stderr,
    exitCode: () => exitCode,
    drained,
    async waitForLines(lines, timeoutMs) {
      const started = Date.now();
      let missing = missingLines(text.stdout, lines);
      while (missing.length > 0 && exitCode === null && Date.now() - started <= timeoutMs) {
        await Bun.sleep(25);
        missing = missingLines(text.stdout, lines);
      }
      if (missing.length > 0 && exitCode !== null) {
        await drained;
        missing = missingLines(text.stdout, lines);
      }
      return missing;
    },
    async stop(stopOptions = {}) {
      if (exitCode === null) {
        const stdin = proc.stdin;
        if (stopOptions.viaStdin === true && typeof stdin === "object" && stdin !== null) {
          await stdin.end();
        } else {
          proc.kill("SIGTERM");
        }
        const timer = setTimeout(() => proc.kill("SIGKILL"), stopOptions.killAfterMs ?? 10_000);
        await proc.exited;
        clearTimeout(timer);
      }
      await drained;
      return exitCode;
    },
  };
}
