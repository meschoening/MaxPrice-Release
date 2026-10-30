import { chmodSync, mkdirSync, statSync } from "node:fs";

// The Headless Hub's data dir on Linux, as the commands that make it leave
// it: `serve`, `setup` and `restore` (ADR-0127 §3, §4, ADR-0128 §2,
// ADR-0130). Its own module so restore.ts and setup.ts take it without
// importing index.ts, whose entry block runs the command line.

export function octal(mode: number): string {
  return "0" + (mode & 0o777).toString(8);
}

// What prepareDataDir did: whether it made the dir, and the permission bits
// it tightened from, or null when it left them alone. Setup's first lines
// report both in its own words (ADR-0128 §2); serve and restore log them
// alone.
export type PreparedDataDir = { created: boolean; tightenedFrom: number | null };

// A Headless Hub's data dir on Linux is 0700 (ADR-0127 §3): made so when
// missing, tightened when group or others can reach it, and each logged, as
// the Headless client's serve does (ADR-0119 §2). It holds hub.json's
// password hash, the archive and the history.
export function prepareDataDir(
  dir: string,
  log: (line: string) => void = (line) => console.log(line),
): PreparedDataDir {
  if (mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined) {
    // mkdir's mode is subject to the umask; chmod is not.
    chmodSync(dir, 0o700);
    log(`[hub] created the data dir ${dir} (0700)`);
    return { created: true, tightenedFrom: null };
  }
  const mode = statSync(dir).mode;
  if ((mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
    log(`[hub] tightened the data dir ${dir} from ${octal(mode)} to 0700`);
    return { created: false, tightenedFrom: mode & 0o777 };
  }
  return { created: false, tightenedFrom: null };
}
