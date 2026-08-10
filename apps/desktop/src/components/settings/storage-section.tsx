import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Folder } from "lucide-react";
import type { StorageReport, StorageSegment, StorageSegmentId } from "@maxprice/shared";
import { useStorage } from "@/state/use-storage";
import { useLiveStatus } from "@/state/use-live-status";
import { useSettings } from "@/state/use-settings";
import {
  archiveHistoryDate,
  corpusRatio,
  formatStorageBytes,
  isInertSegment,
  NOTE_DWELL_MS,
  NOTE_GRACE_MS,
  placeNotePopover,
  segmentShare,
  STORAGE_COPY,
  storageTotalBytes,
  unavailableSegments,
} from "@/lib/storage-view";
import { cn } from "@/lib/utils";

// Settings › Storage › Disk usage — the facts half (map #124, ticket #133).
// `plans/mocks/redesign/storage-glass.html` variant C (`framed`) is the visual
// contract; NOTES.md §"Settings › Storage — Glass" is the written one. Every
// label and sentence is renderer-side (the wire carries ids and bytes only) and
// lives in `lib/storage-view`, which also owns the arithmetic.
//
// Four things below are load-bearing rather than decorative:
//   - Bar order is the WIRE's, never a renderer sort. The legend renders off
//     the same array, so re-sorting one would put the two pictures in different
//     orders; T7 emits every un-reclaimable segment last so the frame reads
//     "ours, then theirs".
//   - Widths are grow weights on a zero basis. See `.st-bar` in globals.css.
//   - Every segment renders, floored at 3px. `other` at 8 KB is 0.0007px on a
//     700px track, and a row that exists in the legend and nowhere in the bar
//     would have the picture contradict the list directly beneath it.
//   - An unmeasured extent never gets a proportion — fixed-width stub, amber
//     frame, "+ unknown" on the total, and the corpus line drops its ratio.

// One bar segment. `share` is a flex-GROW weight; the unavailable stub takes a
// fixed basis instead, so it cannot be read as a proportion at all.
function BarSegment({
  segment,
  share,
  hovered,
  onHover,
}: {
  segment: StorageSegment;
  share: number;
  hovered: boolean;
  onHover: (id: StorageSegmentId | null) => void;
}): React.ReactElement {
  const copy = STORAGE_COPY.seg[segment.id];
  const hover = {
    onMouseEnter: () => onHover(segment.id),
    onMouseLeave: () => onHover(null),
  };

  if (segment.state === "unavailable") {
    return (
      <div
        className={cn("st-seg unknown", hovered && "hl")}
        style={{ flex: "0 0 64px" }}
        title={`${copy.label} — ${segment.detail}`}
        {...hover}
      >
        <span aria-hidden>?</span>
      </div>
    );
  }

  const inert = isInertSegment(segment.id);
  return (
    <div
      className={cn("st-seg", inert && "inert", hovered && "hl")}
      style={{
        flex: `${share.toFixed(6)} 1 0`,
        ...(inert ? {} : { background: `var(--seg-${segment.id})` }),
      }}
      title={`${copy.label} — ${formatStorageBytes(segment.bytes)}`}
      {...hover}
    />
  );
}

// The dwell popover itself. Portalled to `document.body` because every glass
// surface above it declares `backdrop-filter`, and a backdrop-filtered ancestor
// becomes the containing block for `position: fixed` descendants — rendered in
// place, this would be positioned against the Storage panel rather than the
// viewport, and `placeNotePopover`'s viewport clamps would be measuring the
// wrong box.
function NotePopover({
  anchor,
  label,
  note,
}: {
  anchor: DOMRect;
  label: string;
  note: string;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [shown, setShown] = useState(false);

  // Measure, then place, before paint — the popover's own height decides
  // whether it flips above the row, so there is no placing it sight-unseen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(
      placeNotePopover(anchor, el.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [anchor, note]);

  // The fade needs a painted frame at opacity 0 to transition FROM, so this
  // one is deliberately a passive effect rather than a layout effect. It runs
  // once per mount: moving to a neighbouring row re-places the same element
  // with `shown` already true, which is what makes a warm move feel instant.
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return createPortal(
    <div
      ref={ref}
      aria-hidden
      className={cn("note-pop", shown && pos && "show")}
      style={pos ?? { left: 0, top: 0 }}
    >
      <span className="pop-lab">{label}</span>
      {note}
    </div>,
    document.body,
  );
}

function StorageReportView({ report }: { report: StorageReport }): React.ReactElement {
  // Hover links the bar and the legend both ways. Deliberately not a tooltip:
  // the legend is always visible and always exact, so hover is an affordance
  // rather than the only route to a number.
  const [hovered, setHovered] = useState<StorageSegmentId | null>(null);

  // The dwell popover's one piece of state: which row is open, and the box it
  // is anchored to. The row's own `hl` highlight is separate and instant —
  // pointing at a row still lights its bar segment with no delay at all.
  const [note, setNote] = useState<{ id: StorageSegmentId; anchor: DOMRect } | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warm = useRef(false);

  const clearTimers = useCallback((): void => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  const enterRow = useCallback(
    (id: StorageSegmentId, row: HTMLElement): void => {
      clearTimers();
      const show = (): void => {
        // A refetch can replace the legend under a pending dwell; measuring a
        // detached row would place the popover at the origin.
        if (!row.isConnected) return;
        warm.current = true;
        setNote({ id, anchor: row.getBoundingClientRect() });
      };
      if (warm.current) show();
      else openTimer.current = setTimeout(show, NOTE_DWELL_MS);
    },
    [clearTimers],
  );

  // The grace period is what keeps the group warm: leaving a row starts the
  // close, and entering the next one cancels it, so only the first note in a
  // pass pays the dwell.
  const leaveRow = useCallback((): void => {
    clearTimers();
    closeTimer.current = setTimeout(() => {
      warm.current = false;
      setNote(null);
    }, NOTE_GRACE_MS);
  }, [clearTimers]);

  // A popover anchored to a row must not outlive the row's position: we close
  // on scroll rather than let it drift away from what it describes. Capture
  // phase, because the settings column is the thing that scrolls, not window.
  useEffect(() => {
    if (!note) return;
    const close = (): void => {
      clearTimers();
      warm.current = false;
      setNote(null);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("click", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("click", close);
    };
  }, [note, clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  // The archive is the one segment on the bar that can be BROKEN rather than
  // merely large (ADR-0069), and the fault is silent everywhere else, so it is
  // stated above the picture rather than left to a legend note.
  const archiveDegraded = useLiveStatus((s) => s.localArchiveDegraded);

  // The Local archive's left edge (issue #139), resolved in the Timezone
  // setting. null ⇒ no suffix at all — see `archiveHistoryDate`.
  const { data: settings } = useSettings();
  const historyBackTo = archiveHistoryDate(report.localArchiveEarliestAt, settings?.timezone);

  const total = storageTotalBytes(report);
  const unavailable = unavailableSegments(report);
  const ratio = corpusRatio(report);
  const { corpus } = report;

  return (
    <div className="st">
      {archiveDegraded ? (
        <div className="inset warn self-stretch">
          <p className="lead">
            The local archive can&apos;t be written — new usage isn&apos;t being made durable.
            History still shows, but anything Claude Code cleans up meanwhile won&apos;t be
            recoverable. Check disk space and permissions; the app retries automatically.
          </p>
        </div>
      ) : null}

      {/* The corpus context line — ABOVE the bar and never a segment: it is
          ~3× everything below and MaxPrice cannot delete a byte of it. A
          sentence rather than a stat, because a number that size set as a stat
          above a bar reads as the bar's total however it is styled. Three jobs
          in order: name it, relate it to the bar, disclaim it. */}
      <div className="st-corpus">
        <Folder aria-hidden />
        <span>
          MaxPrice reads <b>{formatStorageBytes(corpus.bytes)}</b> of Claude Code session files in{" "}
          {corpus.roots.map((root, i) => (
            <Fragment key={root}>
              {i > 0 ? ", " : null}
              <b>{root}</b>
            </Fragment>
          ))}{" "}
          — {corpus.files.toLocaleString()} files
          {ratio === null ? null : `, about ${ratio}× everything below`}. Claude Code owns those;
          MaxPrice only reads them.
          {corpus.missingRoots.length > 0 ? (
            <>
              {" "}
              <span className="miss">{STORAGE_COPY.corpusMissing(corpus.missingRoots)}</span>
            </>
          ) : null}
        </span>
      </div>

      {/* "Own" contrasts with the corpus above — Claude Code's files, which
          MaxPrice only reads — not with the webview profile, which is disk this
          install caused and which this total therefore includes. */}
      <div className="st-total">
        <span className="lab">{STORAGE_COPY.totalLabel}</span>
        <span className="val">
          {formatStorageBytes(total)}
          {unavailable.length > 0 ? <span className="unknown"> + unknown</span> : null}
        </span>
      </div>

      <div className={cn("st-frame", unavailable.length > 0 && "incomplete")}>
        <div className="st-bar">
          {report.segments.map((segment) => (
            <BarSegment
              key={segment.id}
              segment={segment}
              share={segmentShare(report, segment)}
              hovered={hovered === segment.id}
              onHover={setHovered}
            />
          ))}
        </div>
      </div>

      {unavailable[0] === undefined ? null : (
        <div className="inset warn" style={{ marginTop: 4 }}>
          <p className="lead">{STORAGE_COPY.barIncompleteLead}</p>
          <p>{STORAGE_COPY.barIncomplete(unavailable[0])}</p>
        </div>
      )}

      <div className="st-legend">
        {report.segments.map((segment) => {
          const copy = STORAGE_COPY.seg[segment.id];
          const unknown = segment.state === "unavailable";
          const inert = isInertSegment(segment.id);
          return (
            <div
              key={segment.id}
              className={cn("st-row", hovered === segment.id && "hl")}
              onMouseEnter={(e) => {
                setHovered(segment.id);
                enterRow(segment.id, e.currentTarget);
              }}
              onMouseLeave={() => {
                setHovered(null);
                leaveRow();
              }}
            >
              <span
                aria-hidden
                className={cn("sw", unknown && "unknown", !unknown && inert && "inert")}
                style={unknown || inert ? undefined : { background: `var(--seg-${segment.id})` }}
              />
              {/* The Local archive alone carries a date suffix (issue #139):
                  where every other row answers "how big", this one also has to
                  answer "how far back", because the archive's floor is the one
                  thing about it a user cannot infer. Inline in the label rather
                  than in the dwell note — a 450ms hover is the wrong toll for
                  the section's only irreversible fact — and inline text is in
                  the accessibility tree already, so it needs no `sr-only` twin.
                  Absent (null) whenever there is nothing true to say. */}
              <span className="lab">
                {copy.label}
                {segment.id === "localArchive" && historyBackTo !== null ? (
                  <span className="since"> · {STORAGE_COPY.historyBackTo(historyBackTo)}</span>
                ) : null}
              </span>
              <span className={cn("size", unknown && "unknown")}>
                {unknown ? STORAGE_COPY.unavailable : formatStorageBytes(segment.bytes)}
              </span>
              {/* The note leaves the visible list but NOT the accessibility
                  tree. The reveal is a dwell, which a keyboard and a screen
                  reader have no route into, so hiding this outright would make
                  the copy that carries the section's argument — "MaxPrice
                  can't reclaim it", "this is the only copy" — reachable by
                  mouse alone. Here it is simply part of the row. */}
              <span className="sr-only">{copy.note}</span>
            </div>
          );
        })}
      </div>

      {note === null ? null : (
        <NotePopover
          anchor={note.anchor}
          label={STORAGE_COPY.seg[note.id].label}
          note={STORAGE_COPY.seg[note.id].note}
        />
      )}
    </div>
  );
}

export function StorageSection(): React.ReactElement {
  const { data, isPending, error } = useStorage();

  // The walk is ~0.4s over a live corpus, so the section has a real loading
  // beat. Flat tint blocks pulsing at the system cadence, never a frosted
  // shimmer (the T6 skeleton rule).
  if (isPending) {
    return (
      <div className="skel w-full">
        <i style={{ height: 14, width: "70%" }} />
        <i style={{ height: 26, marginTop: 6 }} />
        <i style={{ height: 10, width: "45%" }} />
        <i style={{ height: 10, width: "52%" }} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="inset danger" role="alert">
        <p className="lead">Couldn&rsquo;t measure disk usage.</p>
        <p>{error.message}</p>
      </div>
    );
  }

  return <StorageReportView report={data} />;
}
