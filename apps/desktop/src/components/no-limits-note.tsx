import type { NoLimits } from "@/lib/organization-scope-view";

// Why a quota tile shows no limit meter: the Quota organization reports no such
// limit (`none` with no weekly cadence; an idle Organization also answers
// `none`, and `quotaSurface` gives it no note), or its limits can't be read
// (`forbidden`). The forbidden wording puts no possessive on the label, since a
// collision-suffixed label or a long rename breaks `'s`, and names no key,
// since the key may be the Hub's. Without a 5-hour reading, blocks fall back to
// estimated windows, so that note says so.
export function NoLimitsNote({
  noLimits,
  what,
}: {
  noLimits: NoLimits;
  what: "5-hour" | "weekly";
}): React.ReactElement {
  const tail = what === "5-hour" ? " — blocks are estimated." : ".";
  return (
    <p className="no-limits-note">
      {noLimits.answer === "none" ? (
        <>
          <b>{noLimits.label}</b>
          {` reports no ${what} limit${tail}`}
        </>
      ) : (
        <>
          Limits for <b>{noLimits.label}</b>
          {` aren't readable${tail}`}
        </>
      )}
    </p>
  );
}
