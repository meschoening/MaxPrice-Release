import { Link } from "react-router-dom";
import { reconnectHint } from "@maxprice/shared";
import { reconnectHintPath } from "@/lib/connect-flow";
import { expiredKeyCount, useUsageKeys } from "@/state/use-usage-keys";

// Shown on the usage tiles when the claude.ai session key has expired
// (usageConnection === "expired"). An expired browser cookie can't be
// refreshed programmatically — it can only be re-pasted — so this is a
// noticeable, one-click path to the Settings re-paste flow, not automation.
// Rendered ONLY for "expired"; "error" (transient) and "disconnected" (never
// configured) deliberately get no CTA (re-pasting fixes neither).
//
// #633 (ADR-0138 §8): the words count the expired keys this machine holds,
// the legacy key included — one keeps today's "Session expired — reconnect",
// several read "N Accounts need reconnecting". A tile that reads expired with
// no local key expired (the Hub's key, on a hub-connected client) is one.
// #639 (#638's D3): it opens Settings › Accounts, at the one dead key's
// Account's Connect where that Account is known (`reconnectHintPath`).
export function UsageExpiredHint(): React.ReactElement {
  const { data } = useUsageKeys();
  return <UsageExpiredHintLink count={expiredKeyCount(data)} to={reconnectHintPath(data)} />;
}

export function UsageExpiredHintLink({
  count,
  to,
}: {
  count: number;
  to: string;
}): React.ReactElement {
  return (
    <Link to={to} className="inline-flex items-center gap-1 text-[11px] text-warn hover:underline">
      ⚠ {reconnectHint(Math.max(1, count))} →
    </Link>
  );
}
