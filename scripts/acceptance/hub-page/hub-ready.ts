import {
  readTextOrNull,
  SERVE_LOCK_FILE,
  serveLockState,
  type ServeLockState,
} from "../hub-process";
import { redactOperatorToken } from "./hub-env";
import { missingLines, type Spawned } from "./spawned";

/** Whether /healthz at `origin` answers 200 as a Hub. */
async function answersAsHub(origin: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(2_000) });
    const body = (await res.json()) as { service?: unknown };
    return res.status === 200 && body.service === "maxprice-hub";
  } catch {
    return false;
  }
}

/** Null when this served-rig child is ready; otherwise the refusal, including bind errors for retry. */
export async function hubReadyProblem(options: {
  child: Spawned;
  port: number;
  embedded: boolean;
  lockPath: string;
  lockBefore: string | null;
  timeoutMs: number;
  health?: (origin: string) => Promise<boolean>;
}): Promise<string | null> {
  const { child, port, embedded, lockPath, lockBefore, timeoutMs, health = answersAsHub } = options;
  const exitedEarly = (code: number): string =>
    `the Hub exited ${code} before it was ready: ${redactOperatorToken(child.stderr()).trim().split("\n").slice(-3).join(" | ")}`;
  const started = Date.now();
  if (embedded) {
    const missing = await child.waitForLines([`LISTENING ${port}`], timeoutMs);
    if (missing.length > 0) {
      const code = child.exitCode();
      return code !== null
        ? exitedEarly(code)
        : `the embedded Hub announced no LISTENING ${port} within ${timeoutMs} ms`;
    }
  }
  const boundLine = embedded ? `LISTENING ${port}` : `[hub] listening on http://127.0.0.1:${port}`;
  let lock: ServeLockState | null = null;
  for (;;) {
    const code = child.exitCode();
    if (code !== null) return exitedEarly(code);
    // The Headless lock record is pre-bind. Require this child's successful
    // bind output before a foreign listener can answer the health request.
    const bound = missingLines(child.stdout(), [boundLine]).length === 0;
    const healthy = bound && (await health(`http://127.0.0.1:${port}`));
    const afterHealth = child.exitCode();
    if (afterHealth !== null) return exitedEarly(afterHealth);
    if (!embedded) {
      lock = serveLockState(readTextOrNull(lockPath), lockBefore, child.proc.pid, port);
      if (lock.kind === "wrong") return `the Hub's ${lock.why}`;
    }
    if (healthy && (lock === null || lock.kind === "recorded")) return null;
    if (Date.now() - started > timeoutMs) {
      if (!bound) return `the Hub logged no ${boundLine} within ${timeoutMs} ms`;
      if (!healthy) return `the Hub's /healthz did not answer 200 within ${timeoutMs} ms`;
      return `the Hub answered /healthz, but its ${SERVE_LOCK_FILE} named no pid ${child.proc.pid} and port ${port} within ${timeoutMs} ms: it reads ${JSON.stringify(readTextOrNull(lockPath))}`;
    }
    await Bun.sleep(100);
  }
}
