// DataTable's search debounce, as plain logic: the text a burst of keystrokes
// settles on, once it has been still for SEARCH_DEBOUNCE_MS. The table filters
// by the settled text and reports that same text through `onSearchChange`, so a
// page reading it (Projects' session list, #640) agrees with the rows shown.

// Long enough that a fast typist doesn't re-filter a multi-thousand-row list
// on every keystroke.
export const SEARCH_DEBOUNCE_MS = 100;

export interface DebounceTimers {
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

const HOST_TIMERS: DebounceTimers = {
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SearchDebouncer {
  // A new search text: restarts the wait, superseding any pending text.
  push: (text: string) => void;
  // Drops a pending text unsettled (the table unmounting).
  cancel: () => void;
}

// `settle` receives each text that stayed unchanged for `ms`, once.
export function searchDebouncer(
  settle: (text: string) => void,
  ms: number = SEARCH_DEBOUNCE_MS,
  timers: DebounceTimers = HOST_TIMERS,
): SearchDebouncer {
  let pending: unknown;
  const cancel = (): void => {
    if (pending !== undefined) timers.clearTimer(pending);
    pending = undefined;
  };
  return {
    push: (text) => {
      cancel();
      pending = timers.setTimer(() => {
        pending = undefined;
        settle(text);
      }, ms);
    },
    cancel,
  };
}
