import { Link } from "react-router-dom";
import { Inbox } from "lucide-react";

// First-launch empty state (Part 6, Task 6.5) — shown on Live / Sessions /
// Projects / Blocks when the engine's event store holds no usage data at all
// (a genuinely empty corpus, not merely an empty date range). The
// corpus-empty signal is `useLiveStatus`'s range-independent `hasData` flag;
// the pages gate on `hasData === false` AND their own report query resolving
// empty, so a user who simply filtered to an empty window still sees the
// inline "No X in this range." text instead of this card.
//
// M6 (T7): a glass panel wearing a DASHED border — the system-wide "nothing
// here yet" affordance (T6's empty insets promoted to a page-level surface) —
// tray glyph in a tint circle, accent Settings link.
//
// This is the no-data-anywhere case. The distinct "no Claude data paths
// configured" case (the user removed every path) is handled separately by the
// Settings page's PathList inline warning — keep the two messages apart.

export function EmptyState(): React.ReactElement {
  return (
    <div className="empty-card">
      <span className="glyph" aria-hidden>
        <Inbox />
      </span>
      <h3>No Claude usage data yet</h3>
      <p>
        Claude Code writes usage data to <span className="path-lit">~/.claude/projects</span> (or{" "}
        <span className="path-lit">~/.config/claude/projects</span>). Open a Claude Code session,
        then come back — your usage will show up here automatically.
      </p>
      <p className="also">
        or <Link to="/settings">add a custom data path in Settings</Link>
      </p>
    </div>
  );
}
