import { useMemo } from "react";
import { DEFAULT_WEEK, resolveWeekWindow, type WeekWindow } from "@maxprice/shared";
import { useNowTick } from "./use-now-tick";
import { useSettings } from "./use-settings";
import { useUsageCurrent } from "./use-usage-current";

// The resolved Week (ADR-0083): the Settings `week` + the latest weekly-limit
// reading + a 1/min tick, through the ONE resolver in `@maxprice/shared`.
// The tick is what lets a stale reset roll forward and a custom anchor advance
// past its weekday without a refetch; the memo keys on the setting's three
// primitives rather than the settings-cache object, so a settings write that
// touches another field re-resolves to a reference-equal answer anyway.
export function useWeekWindow(): WeekWindow {
  const { data: settings } = useSettings();
  const { data: usage } = useUsageCurrent();
  const now = useNowTick(60_000);
  const week = settings?.week ?? DEFAULT_WEEK;
  const tz = settings?.timezone;
  // `weeklyResetAt`, not `sample.weekly.resetAt`: a poll with no 5h window
  // in flight reports `sample: null` while the weekly window stays known.
  const resetAt = usage?.weeklyResetAt ?? null;
  return useMemo(
    () =>
      resolveWeekWindow(
        { mode: week.mode, weekday: week.weekday, time: week.time },
        resetAt,
        now,
        tz,
      ),
    [week.mode, week.weekday, week.time, resetAt, now, tz],
  );
}
