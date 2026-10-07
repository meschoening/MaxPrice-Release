import {
  createUsagePoller,
  type CreateUsagePollerOptions,
  type PollerStatus,
  type UsagePoller,
} from "@maxprice/usage-core";
import type { LiveHub } from "./live-hub";

export type LiveUsagePoller = UsagePoller & {
  // Re-derive the status after the installed Home or the persisted scope moved
  // outside a poll: one status patch, and no reading.
  republish: () => void;
};

// The poller as the sidecar's live channel carries it (ADR-0104). Every polled
// Organization's reading goes out as it lands, stamped with that Organization
// even when it is null, so the renderer can key each one. Status's
// `usageConnection`, and `getCurrent()` with no Organization, describe the
// Quota organization of the persisted scope — Home until a scope names another
// — while the rest of the status stays the key's.
//
// A Home change emits no reading. The renderer keys each Organization's reading
// on its own entry and derives the one it displays from the scope and Home, so
// the new Home's reading is already where the display turns to.
export function createLiveUsagePoller(
  opts: Omit<CreateUsagePollerOptions, "liveHub"> & {
    liveHub: Pick<LiveHub, "emitUsageSample" | "patchStatus">;
    // The persisted scope's Quota organization; null only with no Home.
    getQuotaOrganization: () => string | null;
  },
): LiveUsagePoller {
  function publish(status: Partial<PollerStatus>): void {
    opts.liveHub.patchStatus({
      ...status,
      usageConnection: poller.getCurrent(opts.getQuotaOrganization()).connection,
    });
  }
  const poller = createUsagePoller({
    ...opts,
    liveHub: {
      emitUsageSample: (organizationUuid, sample) => {
        opts.liveHub.emitUsageSample({
          organizationUuid,
          sample,
          weeklyResetAt: poller.getCurrent(organizationUuid).weeklyResetAt,
        });
      },
      patchStatus: publish,
    },
  });
  return {
    ...poller,
    getCurrent: (organization = opts.getQuotaOrganization()) => poller.getCurrent(organization),
    republish: () => publish({}),
  };
}
