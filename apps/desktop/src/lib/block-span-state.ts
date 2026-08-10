import type { BlockSpanWindow, IntradayResponse } from "@maxprice/shared";
import type { Span } from "@/state/filters";

// ADR-0031: the `block` span's empty-state derivation, shared by the model and
// by-project intraday charts. A null `blockWindow` on a block-span response
// means there's no active block — the chart + foot are replaced by the empty
// state. `blockWindow` is the resolved frame (used later by the chart foot);
// non-block spans always read `null`. `isEmpty` is only true once the response
// has arrived (`data !== undefined`) AND it carries `blockWindow === null`, so a
// still-pending block query renders the chart's loading state, not the empty one.
export function blockSpanState(
  span: Span,
  data: IntradayResponse | undefined,
): { blockWindow: BlockSpanWindow | null; isEmpty: boolean } {
  return {
    blockWindow: span === "block" ? (data?.blockWindow ?? null) : null,
    isEmpty: span === "block" && data !== undefined && data.blockWindow === null,
  };
}
