import { formatRelativeTime } from "@maxprice/shared";

// The Headless Hub's framing of a Gateway (ADR-0141 §7, §8). Its state,
// warning and check-failure words are packages/shared's (`gateway-words.ts`,
// #673), which the hub tray app's Gateways card, the Desktop and the Headless
// client read too.

// The age of a Gateway's newest drained record, as `status`'s Gateway row
// ends: `last record 5m ago`, or `no record yet` before the first this run
// (`lastRecordAt` is null after a restart until the next one).
export function gatewayLastRecord(lastRecordAt: string | null, now: number): string {
  return lastRecordAt === null
    ? "no record yet"
    : `last record ${formatRelativeTime(lastRecordAt, now)}`;
}
