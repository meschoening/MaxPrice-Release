import type { UsageConnection } from "@maxprice/shared";
import type { PollerStatus } from "@maxprice/usage-core";
import type { HubFanout } from "./fanout";
import type { OrganizationRoster } from "./organization-roster";

// The Hub's usageConnection summarises the KEY (#267 item 2), never one
// Organization: a client derives its own from the `organizations` map. The
// poller reads `disconnected` for no key AND for a key awaiting its first
// answer (the pending read clients skip); a discovery that failed or listed
// nothing is awaiting nothing, so with no answer it reads `error`. `expired`,
// `connected` and an all-forbidden/error `error` pass through.
export function hubUsageConnection(
  polled: UsageConnection,
  discoveryFailed: boolean,
): UsageConnection {
  return polled === "disconnected" && discoveryFailed ? "error" : polled;
}

export type HubUsageStatus = {
  patchStatus: (status: PollerStatus) => void;
  setDiscoveryFailed: (failed: boolean) => void;
};

// Poller → fanout. A set change drops live state for Organizations that left,
// never history: no status entry means no answered endpoint, so persisted
// history cannot mint a current entry simply because a credential/set was
// installed. Each publish records the Limits answers in the roster (#284).
export function createHubUsageStatus(
  fanout: Pick<HubFanout, "getStatus" | "patchStatus">,
  opts: { roster?: Pick<OrganizationRoster, "recordLimits"> } = {},
): HubUsageStatus {
  let polled: UsageConnection = fanout.getStatus().usageConnection;
  let failed = false;
  return {
    patchStatus: (status) => {
      polled = status.usageConnection;
      try {
        opts.roster?.recordLimits(status.organizations);
      } catch (err) {
        console.warn("[hub] organization roster write failed:", err);
      }
      fanout.patchStatus({
        ...status,
        usageConnection: hubUsageConnection(polled, failed),
        usageWeeklyResetAt: Object.fromEntries(
          Object.entries(fanout.getStatus().usageWeeklyResetAt).filter(([id]) =>
            Object.hasOwn(status.organizations, id),
          ),
        ),
        usageCurrent: Object.fromEntries(
          Object.entries(fanout.getStatus().usageCurrent).filter(([id]) =>
            Object.hasOwn(status.organizations, id),
          ),
        ),
      });
    },
    setDiscoveryFailed: (next) => {
      failed = next;
      fanout.patchStatus({ usageConnection: hubUsageConnection(polled, failed) });
    },
  };
}
