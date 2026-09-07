import {
  engineCell,
  sidecarCell,
  versionCell,
  type AppInfoCell,
  type NotePart,
} from "@/lib/app-info";
import { useLiveStatus } from "@/state/use-live-status";
import { cn } from "@/lib/utils";

// Settings › App info — three read-only rows (Version / Engine / Sidecar) in
// the `pairs` grammar resolved by T3 (map #100): a label column and
// a value column, one section rather than four, so read-once facts don't take
// on the heading weight of the two actions beside them. The shipped section is
// its own visual contract (ADR-0088); every string comes from `lib/app-info`.
//
// The first three facts used to live in the chrome — the sidebar identity row's
// version chip and two lines in the sidebar foot — which this section replaced.
// The Sidecar row joined them on 2026-08-01 and is the section's one LIVE row,
// so it is also the one row that carries a dot: the foot's charter is state you
// glance at and act on, and the SSE connection is already on every page in the
// topbar refresh pill. The three static rows keep `dot: null` and render
// exactly as before.
//
// The Pricing data row lived here from 2026-07-29 until ADR-0085 (2026-09-05)
// moved it to its own Settings › Pricing section beside the manual refresh
// chip; `pricingCell` still derives its strings there.

function Note({ parts, tone }: { parts: NotePart[]; tone: "" | "warn" }): React.ReactElement {
  return (
    <p className={cn("ai-note", tone)}>
      {parts.map((part, i) =>
        "code" in part ? <code key={i}>{part.code}</code> : <span key={i}>{part.text}</span>,
      )}
    </p>
  );
}

// dt + dd as a fragment, so both stay direct children of the `.ai-pairs` grid.
function Row({ label, cell }: { label: string; cell: AppInfoCell }): React.ReactElement {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <div className={cn("ai-val", cell.tone)} title={cell.title ?? undefined}>
          {cell.dot === null ? null : (
            <span
              aria-hidden
              className={cn("dot", cell.dot.variant, cell.dot.pulse && "pulse-anim")}
            />
          )}
          {cell.value}
        </div>
        {cell.meta === null ? null : <div className="ai-meta">{cell.meta}</div>}
        {cell.note === null ? null : <Note parts={cell.note} tone={cell.noteTone} />}
      </dd>
    </>
  );
}

export function AppInfoSection(): React.ReactElement {
  const engineVersion = useLiveStatus((s) => s.engineVersion);
  const pricing = useLiveStatus((s) => s.pricing);
  const connectionState = useLiveStatus((s) => s.connectionState);

  return (
    <dl className="ai-pairs">
      <Row label="Version" cell={versionCell(__APP_VERSION__)} />
      {/* `pricing !== null` is the drift evidence that actually fires: a frame
          carrying no `pricing` proves a pre-ADR-0053 binary whatever the two
          version numbers say. Both fields land in one store `set()`. */}
      <Row label="Engine" cell={engineCell(engineVersion, __APP_VERSION__, pricing !== null)} />
      {/* Last, after the static facts: the section's only live row, and the
          only one whose value can change while you are looking at it. */}
      <Row label="Sidecar" cell={sidecarCell(connectionState)} />
    </dl>
  );
}
