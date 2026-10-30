// The Headless client's exit codes: ADR-0119 §6 for every command,
// ADR-0120 §2's 5 and 6 for `serve`, and ADR-0123 §5's 100 for
// `update --check`.
export const EXIT = {
  OK: 0,
  // A daemon error, a timeout, a bad response, a crash or a failed bind.
  FAILURE: 1,
  USAGE: 2,
  // The LSB `status` code, as `systemctl status` exits for an inactive unit.
  NOT_RUNNING: 3,
  SKEW: 4,
  // `serve` found another `serve` holding its data dir's lock; the unit's
  // `RestartPreventExitStatus=5` keeps systemd from retrying it.
  ALREADY_RUNNING: 5,
  // `serve` refused a settings.json it cannot trust: unreadable,
  // unparseable, not an object, or a rejected Home or tracked list (ADR-0122 §7, amending
  // ADR-0120 §2). A relaunch cannot fix a file, so the unit's
  // `RestartPreventExitStatus=5 6` keeps systemd from retrying it.
  SETTINGS_REFUSED: 6,
  // `update --check` found a newer release, as `dnf check-update` exits 100
  // when it lists one (ADR-0123 §5), so a script can tell "an update" from
  // "the check failed".
  UPDATE_AVAILABLE: 100,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

// A line under an error: free text, or a label and the command it names,
// which the renderer aligns with the other pairs in its block.
export type Hint = string | { label: string; command: string };

// An error a command expects, with the code it exits with. Anything else a
// command throws exits 1.
export class CliError extends Error {
  constructor(
    readonly code: ExitCode,
    message: string,
    readonly hints: readonly Hint[] = [],
  ) {
    super(message);
    this.name = "CliError";
  }
}

// A usage error is one line too (ADR-0119 §7): the help to read rides it.
export function usageError(message: string, help: string): CliError {
  return new CliError(EXIT.USAGE, `${message} (see '${help}')`);
}
