import { Link } from "react-router-dom";

// Shown on the usage tiles when the claude.ai session key has expired
// (usageConnection === "expired"). An expired browser cookie can't be
// refreshed programmatically — it can only be re-pasted — so this is a
// noticeable, one-click path to the Settings re-paste flow, not automation.
// Rendered ONLY for "expired"; "error" (transient) and "disconnected" (never
// configured) deliberately get no CTA (re-pasting fixes neither).
export function UsageExpiredHint(): React.ReactElement {
  return (
    <Link
      to="/settings"
      className="inline-flex items-center gap-1 text-[11px] text-warn hover:underline"
    >
      ⚠ Session expired — reconnect →
    </Link>
  );
}
