import type { SessionRow } from "@maxprice/shared";
import { cn } from "@/lib/utils";
import {
  organizationCellLabels,
  sessionTag,
  type SessionTag as SessionTagView,
} from "@/lib/session-assignment";

// How the Sessions table reads a session's Organization attribution (#312):
// the `presumed` / `assigned` pill beside an owner-less session's id, and the
// All-scope Organization cell that names both halves of a partly owned one.
// Pure — props in, markup out — so the static markup is testable without the
// page's query hooks.

// The pill: `presumed` soft, `assigned` accent, ` · part` for a partly owned
// session. The tooltip says where its owner-less usage counts, and why. The
// owner-less review list names the target inside the pill too (`withTarget`),
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

// The Session cell: short id over the full one. Past one tracked Organization
// (`multi`) an owner-less session's short id is followed by its tag; otherwise,
// and for a session whose usage all carries Owner records, it is the shipped
// cell to the byte.
export function SessionCell({
  row,
  labels,
  multi,
}: {
  row: SessionRow;
  labels: ReadonlyMap<string, string>;
  multi: boolean;
}): React.ReactElement {
  const tag = multi ? sessionTag(row, labels) : null;
  return (
    <span className="lead">
      <b className={tag === null ? undefined : "attr-id-line"}>
        {row.sessionId.slice(0, 8)}
        {tag === null ? null : <SessionTag tag={tag} />}
      </b>
      <small className="num">{row.sessionId}</small>
    </span>
  );
}

// The Organization cell under All organizations (#289): a partly owned
// session's owned label with its owner-less part beneath; any other session
// the shipped single label, or an em dash for none.
export function SessionOrganizationCell({
  row,
  labels,
}: {
  row: SessionRow;
  labels: ReadonlyMap<string, string>;
}): React.ReactElement {
  const { label, ownerlessLabel } = organizationCellLabels(row, labels);
  if (label === null) return <span className="text-soft">—</span>;
  const lead = (
    <span className="trunc" title={label}>
      {label}
    </span>
  );
  if (ownerlessLabel === undefined) return lead;
  const beneath = `owner-less part · ${ownerlessLabel}`;
  return (
    <span className="lead org-cell-split">
      {lead}
      <small className="trunc" title={beneath}>
        {beneath}
      </small>
    </span>
  );
}
