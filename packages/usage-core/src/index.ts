// The shared usage-limits engine room (ADR-0035): the claude.ai usage client,
// the 1/min poller, and the on-disk sample store — consumed by BOTH the
// sidecar (apps/sidecar) and the hub (apps/hub). fake-claude.ts is deliberately
// NOT re-exported here: it is a test/dev fixture, reachable only via the
// "./fake-claude" subpath so compiled binaries never bundle it.
// self-update.ts is likewise reachable only via "./self-update": the headless
// products update themselves, the sidecar and the Desktop client never do.
// flock.ts, the headless products' lock binding, only via "./flock".
// update-check.ts, the headless daemons' update check, only via
// "./update-check", and test-channel.ts, a fixture, only via "./test-channel".
// secrets-file.ts, the headless secrets files' mechanics, only via
// "./secrets-file", and secret-input.ts, their hidden-prompt reader, only via
// "./secret-input". The headless products' service mechanism is subpath-only
// too: home-path.ts via "./home-path", serve-lock.ts (one daemon per data
// dir) via "./serve-lock", and the systemd user unit's systemd-unit.ts,
// systemctl.ts and systemd-service.ts via their own; test-systemd.ts, a
// fixture, only via "./test-systemd".
export * from "./usage-client";
// The listing's element, which `ListOrgsResult` carries (#283).
export type { ListedOrg } from "@maxprice/shared";
export * from "./poller";
export * from "./sample-store";
// The merge rule's fullness predicate (ADR-0103), beside the key and total
// (`fleetEventKey`, `fleetTokenTotal`, from ./fleet-sync-store).
export {
  fleetCopySupersedes,
  fleetDedupFullness,
  fleetFullnessExceeds,
  type FleetFullness,
} from "@maxprice/shared";
export * from "./fleet-sync-store";
export * from "./identity-directory";
export * from "./event-sync";
export * from "./hub-client";
export * from "./sse-pump";
export * from "./parent-watchdog";
export * from "./mono-clock";
export * from "./constant-time";
