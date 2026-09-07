import type { PricingFailureKind, PricingRefreshResponse, PricingStatus } from "@maxprice/shared";
import { FAILURE_CLAUSE, pricingCell, unpricedPricingNote } from "./app-info";
import { PricingRefreshTimeoutError } from "./pricing-refresh";

// THE COPY CONTRACT for Settings › Pricing (ADR-0085).
//
// Every user-visible string the section can show lives here, and the mapping
// from state to strings is a pure function — the `lib/update-section.ts` shape,
// so the states are pinnable and a review argues about words in one place.
//
// The shape was chosen from a four-variant prototype (2026-09-05, variant D):
// the Updates grammar — one chip, a `role="status"` line beside it, a hairline
// under the row while work is in flight — with the pricing PROVENANCE as the
// line's resting text. The Pricing data row that used to live in App info moved
// here whole: `pricingCell` still derives its value / meta / note, and this
// module composes them onto the line. The three rejected alternatives were a
// chip inside the App info value stack, a text link at the end of its note, and
// a third action column on the App info grid.
//
// The button is ALWAYS available: a newly announced model needs its prices
// before the ~24h tick would fetch them, which is half the reason it exists.

export const PRICING_SECTION_DESCRIPTION =
  "Model prices come from LiteLLM; the built-in snapshot is the fallback when it can’t be reached.";

/** Why a refresh failed, as far as the line needs to distinguish. */
export type PricingSectionFailure =
  // The sidecar never answered inside the ceiling.
  | { kind: "timeout" }
  // It answered badly — non-2xx, a network refusal, a body off its schema.
  | { kind: "error" }
  // It answered fine, and the upstream attempt it ran failed. `failure` is the
  // sidecar's own classification (ADR-0053).
  | { kind: "attempt"; failure: PricingFailureKind };

export type PricingSectionState =
  | { kind: "idle" }
  | { kind: "refreshing" }
  | { kind: "refreshed"; newModels: number }
  | { kind: "failed"; reason: PricingSectionFailure; detail: string };

export type PricingSectionView = {
  chip: { label: string; disabled: boolean };
  /** The line beside the chip. Never empty — at rest it is the provenance. */
  status: string;
  statusTone: "" | "warn" | "err";
  /** Detail that must not be printed, riding along as the line's `title`. */
  statusTitle: string | null;
  /** The indeterminate hairline under the row — work is in flight. */
  track: boolean;
  /** Pricing exposure or an idle automatic-retry note beneath the control. */
  note: string | null;
  noteTone: "" | "warn";
};

const REFRESH = "Refresh prices";

function noteText(parts: ReturnType<typeof pricingCell>["note"]): string | null {
  if (parts === null) return null;
  return parts.map((p) => ("code" in p ? p.code : p.text)).join("");
}

/** Map the section's knowledge onto its strings. Pure. */
export function pricingSectionView(
  state: PricingSectionState,
  pricing: PricingStatus | null,
  now: number,
  tz?: string,
): PricingSectionView {
  const cell = pricingCell(pricing, now, tz);
  const unpricedNote = unpricedPricingNote(pricing);
  // The resting line: the App info row's value and meta joined on the same
  // middle dot the value already uses. A `null` meta (no pricing on the wire)
  // collapses to the note's sentence, which is the only thing the cell has to say.
  const provenance =
    cell.meta === null ? (noteText(cell.note) ?? cell.value) : `${cell.value} · ${cell.meta}`;
  const provenanceTone: "" | "warn" = cell.tone === "warn" ? "warn" : "";

  switch (state.kind) {
    case "idle":
      return {
        chip: { label: REFRESH, disabled: false },
        status: provenance,
        statusTone: provenanceTone,
        statusTitle: cell.title,
        track: false,
        // Only when meta is present: otherwise the note IS the line.
        note: cell.meta === null ? null : noteText(cell.note),
        noteTone: cell.noteTone === "warn" ? "warn" : "",
      };

    case "refreshing":
      // Suppress automatic-retry copy during a manual attempt, but keep the
      // unpriced warning until a snapshot actually resolves the models.
      return {
        chip: { label: "Refreshing…", disabled: true },
        status: provenance,
        statusTone: provenanceTone,
        statusTitle: cell.title,
        track: true,
        note: unpricedNote,
        noteTone: unpricedNote === null ? "" : "warn",
      };

    case "refreshed":
      return {
        chip: { label: REFRESH, disabled: false },
        status:
          state.newModels === 0
            ? unpricedNote === null
              ? "Refreshed · up to date"
              : "Refreshed · models still unpriced"
            : `Refreshed · ${state.newModels} new ${state.newModels === 1 ? "model" : "models"}`,
        statusTone: "",
        statusTitle: null,
        track: false,
        note: unpricedNote,
        noteTone: unpricedNote === null ? "" : "warn",
      };

    case "failed":
      return {
        chip: { label: REFRESH, disabled: false },
        status: failedLine(state.reason),
        statusTone: "err",
        statusTitle: state.detail === "" ? null : state.detail,
        track: false,
        note: unpricedNote,
        noteTone: unpricedNote === null ? "" : "warn",
      };
  }
}

// Two different problems on the request path — a sidecar that never answered
// versus one that answered badly (ADR-0059's distinction) — and a third, the
// common one: the sidecar answered and the UPSTREAM fetch it ran failed, in
// which case the sidecar's own classification is the truest thing to say.
function failedLine(reason: PricingSectionFailure): string {
  switch (reason.kind) {
    case "timeout":
      return "Refresh timed out — the sidecar didn’t answer.";
    case "error":
      return "Refresh failed.";
    case "attempt":
      return `Couldn’t refresh — ${FAILURE_CLAUSE[reason.failure]}.`;
  }
}

/** A 200 is not a success: the attempt inside it may have failed. */
export function classifyRefreshResponse(response: PricingRefreshResponse): PricingSectionState {
  const failure = response.pricing.lastAttempt?.failure ?? null;
  if (failure !== null) {
    return {
      kind: "failed",
      reason: { kind: "attempt", failure: failure.kind },
      detail: failure.detail,
    };
  }
  return { kind: "refreshed", newModels: response.newModels };
}

export function classifyRefreshError(err: unknown): PricingSectionState {
  const detail = err instanceof Error ? err.message : String(err);
  return {
    kind: "failed",
    reason: err instanceof PricingRefreshTimeoutError ? { kind: "timeout" } : { kind: "error" },
    detail,
  };
}
