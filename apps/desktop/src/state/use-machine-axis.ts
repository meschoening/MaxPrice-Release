import { useMemo } from "react";
import type { HubMachine } from "@maxprice/shared";
import { useFilters, type GroupByAxis } from "./filters";
import { useSettings } from "./use-settings";
import { useLiveStatus } from "./use-live-status";
import { useMachines } from "./use-machines";
import {
  expandMachineFilter,
  foldMachines,
  machineUiEnabled,
  type FoldedMachine,
} from "@/lib/machines";

// ADR-0041 (M6) — the machine-axis gate hook, the ONE place the "replica on AND
// hub configured" rule is evaluated for the renderer's three machine surfaces
// (rail popover / group-by axis / list+detail attribution). Setting-gated,
// never data-presence-gated; persisted machine state is KEPT while gated off —
// effectiveAxes/machineParams simply drop machine from the EFFECTIVE selection
// without ever writing the filters store.
export type MachineAxis = {
  enabled: boolean;
  self: string | null;
  directory: HubMachine[];
  folded: FoldedMachine[];
  effectiveAxes: (axes: GroupByAxis[]) => GroupByAxis[];
  // Alias-closure-expanded machine= values (empty when gated off or no filter).
  machineParams: string[];
};

const NO_MACHINES: HubMachine[] = [];

export function useMachineAxis(): MachineAxis {
  const { data: settings } = useSettings();
  const hubConnection = useLiveStatus((s) => s.hubConnection);
  const machinesFilter = useFilters((s) => s.machines);

  const enabled = machineUiEnabled({
    hubFleetReplica: settings?.hubFleetReplica ?? true,
    hubUrl: settings?.hubUrl ?? "",
    hubConnection,
  });
  // Gated-off clients never issue the loopback fetch.
  const machinesQ = useMachines(enabled);
  const directory = machinesQ.data?.machines ?? NO_MACHINES;
  const self = machinesQ.data?.self ?? null;

  return useMemo<MachineAxis>(
    () => ({
      enabled,
      self,
      directory,
      folded: enabled && self !== null ? foldMachines(directory, self) : [],
      effectiveAxes: (axes) => (enabled ? axes : axes.filter((a) => a !== "machine")),
      machineParams: enabled ? expandMachineFilter(machinesFilter, directory) : [],
    }),
    [enabled, self, directory, machinesFilter],
  );
}
