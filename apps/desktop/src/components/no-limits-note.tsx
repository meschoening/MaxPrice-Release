import type { NoLimit } from "@/lib/organization-scope-view";

// Why a quota tile shows no limit meter: the Quota organization has no such
// limit (its Window state is `absent`; an idle window is a limit, and
// `quotaSurface` gives it no note, #384), or its limits can't be read
// (`forbidden`). The forbidden wording puts no possessive on the label, since a
// collision-suffixed label or a long rename breaks `'s`, and names no key,
// since the key may be the Hub's. Without a 5-hour reading, blocks fall back to
// estimated windows, so that note says so.
export function NoLimitsNote({
  noLimit,
  what,
}: {
  noLimit: NoLimit;
  what: "5-hour" | "weekly";
}): React.ReactElement {
  const tail = what === "5-hour" ? " — blocks are estimated." : ".";
  return (
    <p className="no-limits-note">
      {noLimit.reason === "absent" ? (
        <>
          <b>{noLimit.label}</b>
          {` reports no ${what} limit${tail}`}
        </>
      ) : (
        <>
          Limits for <b>{noLimit.label}</b>
          {` aren't readable${tail}`}
        </>
      )}
    </p>
  );
}
