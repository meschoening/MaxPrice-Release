import { cn } from "@/lib/utils";
import type { SessionTag as SessionTagView } from "@/lib/session-assignment";

// How a sessions list reads a session's Organization attribution (#312):
// the `presumed` / `assigned` pill beside an owner-less session's id. Pure —
// props in, markup out — so the static markup is testable without the page's
// query hooks.

// The pill: `presumed` soft, `assigned` accent, ` · part` for a partly owned
// session. The tooltip says where its owner-less usage counts, and why. The
// Unattributed usage's list names the target inside the pill too (`withTarget`),
// where a mixed group's sessions would otherwise read alike.
export function SessionTag({
  tag,
  withTarget = false,
}: {
  tag: SessionTagView;
  withTarget?: boolean;
}): React.ReactElement {
  return (
    <span className={cn("attr-tag", tag.kind)} title={tag.title}>
      {withTarget ? `${tag.kind} · ${tag.label}` : tag.kind}
      {tag.part ? <span className="part"> · part</span> : null}
    </span>
  );
}
