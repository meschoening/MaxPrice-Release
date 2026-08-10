import type { MachineAxis } from "@/state/use-machine-axis";
import { machineColor, machineName } from "@/lib/machines";
import { cn } from "@/lib/utils";

// One machine's colored dot + resolved name (ADR-0041 M6) — the list/detail
// attribution atom. Colors come from the ONE canonical foldMachines assignment,
// so the dot always matches the chart hue for the same machine.
export function MachineChip({
  id,
  machineAxis,
  hideName = false,
  className,
}: {
  id: string;
  machineAxis: MachineAxis;
  hideName?: boolean;
  className?: string;
}): React.ReactElement {
  const name = machineName(id, machineAxis.directory);
  return (
    <span className={cn("mdot inline-flex items-center gap-1.5 min-w-0", className)} title={name}>
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ background: machineColor(id, machineAxis.folded, machineAxis.directory) }}
      />
      {hideName ? null : <span className="truncate">{name}</span>}
    </span>
  );
}
