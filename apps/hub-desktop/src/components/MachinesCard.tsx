import { useEffect, useState } from "react";
import type { HubMachine } from "@maxprice/shared";
import { useHubMachines } from "@/state/use-hub-machines";
import { useMergeMachine, usePurgeMachine, useRenameMachine } from "@/state/use-machine-mutations";
import { useNowTick } from "@/state/use-now-tick";
import { dotVariant } from "@/lib/dot-variant";
import { showToast } from "@/lib/toast";
import {
  formatCount,
  machineStateDot,
  machineSubline,
  resolveMergeTargetName,
  shortMachineId,
  sortMachines,
  stillSharing,
} from "@/lib/presentation";

// The directory-backed Machines card (ADR-0041 M7) — every directory entry,
// live and orphaned, with per-row rename / merge-into / purge flows. Replaces
// the M3 roster card whenever the daemon speaks event sync (the App swaps on
// the 404 probe). The kebab opens a floating glass leaf (T1: the .kmenu
// recipe re-anchored to the row; outside click closes it); flows open as
// insets under the row, one at a time. The purge inset carries the
// merge-source and still-sharing warnings and a type-the-name confirm.

type Flow = { machineId: string; kind: "menu" | "rename" | "merge" | "purge" };

export function MachinesCard(): React.ReactElement {
  const { data, isError, isPending } = useHubMachines();
  const now = useNowTick();
  const rename = useRenameMachine();
  const merge = useMergeMachine();
  const purge = usePurgeMachine();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [mergeTarget, setMergeTarget] = useState("");
  const [purgeConfirm, setPurgeConfirm] = useState("");

  const machines = data !== undefined && data !== null ? sortMachines(data.machines) : [];

  const openFlow = (next: Flow, m: HubMachine): void => {
    setFlow(next);
    setRenameInput(m.name);
    setMergeTarget("");
    setPurgeConfirm("");
    rename.reset();
    merge.reset();
    purge.reset();
  };
  const closeFlow = (): void => setFlow(null);

  // Outside click closes an open kebab MENU (the glass leaf convention);
  // committed flows only close via their own buttons. Clicking another
  // row's kebab re-opens there — its own handler runs before this one sees
  // the .kebab guard.
  const menuOpen = flow?.kind === "menu";
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent): void => {
      if (e.target instanceof Element && e.target.closest(".kmenu, .kebab") !== null) return;
      setFlow(null);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [menuOpen]);

  return (
    <section className="panel card" aria-label="Machines">
      <div className="card-head">
        <span className="eyebrow">Machines</span>
        <span className="status">{data ? formatCount(machines.length) : "—"}</span>
      </div>
      <div>
        {isPending ? (
          <p className="hint">Loading…</p>
        ) : isError ? (
          <p className="err">Couldn&rsquo;t reach the hub.</p>
        ) : machines.length === 0 ? (
          <p className="hint">No machines yet — clients register on first contact.</p>
        ) : (
          machines.map((m) => {
            const active = flow?.machineId === m.machineId ? flow : null;
            return (
              <div key={m.machineId} className="mrow">
                <div className="mrow-top">
                  <span aria-hidden className={`dot ${dotVariant(machineStateDot(m))}`} />
                  <span className="mname">{m.name}</span>
                  <span className="mid">{shortMachineId(m.machineId)}</span>
                  <span className="mcount">{formatCount(m.eventCount ?? 0)} events</span>
                  <button
                    type="button"
                    className="chip kebab"
                    aria-label={`actions for ${m.name}`}
                    aria-haspopup="menu"
                    aria-expanded={active !== null}
                    onClick={() =>
                      active !== null
                        ? closeFlow()
                        : openFlow({ machineId: m.machineId, kind: "menu" }, m)
                    }
                  >
                    ⋯
                  </button>
                </div>
                <p className="msub">{machineSubline(m, now, machines)}</p>

                {active?.kind === "menu" ? (
                  <div className="kmenu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => openFlow({ machineId: m.machineId, kind: "rename" }, m)}
                    >
                      Rename…
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => openFlow({ machineId: m.machineId, kind: "merge" }, m)}
                    >
                      Merge into…
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="danger"
                      onClick={() => openFlow({ machineId: m.machineId, kind: "purge" }, m)}
                    >
                      Purge…
                    </button>
                  </div>
                ) : null}

                {active?.kind === "rename" ? (
                  <div className="flow mflow">
                    <div className="btns">
                      <input
                        className="input"
                        value={renameInput}
                        onChange={(e) => setRenameInput(e.target.value)}
                        maxLength={63}
                        aria-label="machine name"
                        style={{ flex: 1 }}
                      />
                      <button
                        type="button"
                        className="chip active"
                        disabled={rename.isPending || renameInput.trim() === ""}
                        onClick={() =>
                          rename.mutate(
                            { machineId: m.machineId, name: renameInput.trim() },
                            {
                              onSuccess: () => {
                                closeFlow();
                                showToast("Machine renamed");
                              },
                            },
                          )
                        }
                      >
                        {rename.isPending ? "Saving…" : "Save"}
                      </button>
                      <button type="button" className="chip ghost-btn" onClick={closeFlow}>
                        Cancel
                      </button>
                    </div>
                    {rename.isError ? <p className="err">{rename.error.message}</p> : null}
                  </div>
                ) : null}

                {active?.kind === "merge" ? (
                  <div className="flow mflow">
                    <div className="btns">
                      <div className="select-wrap">
                        <select
                          className="input"
                          value={mergeTarget}
                          onChange={(e) => setMergeTarget(e.target.value)}
                          aria-label="merge target"
                        >
                          <option value="">Merge {m.name} into…</option>
                          {machines
                            .filter((t) => t.machineId !== m.machineId)
                            .map((t) => (
                              <option key={t.machineId} value={t.machineId}>
                                {t.name}
                              </option>
                            ))}
                        </select>
                        <CaretIcon />
                      </div>
                      <button
                        type="button"
                        className="chip active"
                        disabled={merge.isPending || mergeTarget === ""}
                        onClick={() =>
                          merge.mutate(
                            { machineId: m.machineId, into: mergeTarget },
                            {
                              onSuccess: () => {
                                closeFlow();
                                showToast("Machine merged");
                              },
                            },
                          )
                        }
                      >
                        {merge.isPending ? "Merging…" : "Merge"}
                      </button>
                      <button type="button" className="chip ghost-btn" onClick={closeFlow}>
                        Cancel
                      </button>
                    </div>
                    <p className="hint">
                      Alias only — {m.name}&rsquo;s events keep their attribution and render under
                      the target&rsquo;s name. Reversible by purging no one: re-merge or rename
                      anytime.
                    </p>
                    {merge.isError ? <p className="err">{merge.error.message}</p> : null}
                  </div>
                ) : null}

                {active?.kind === "purge" ? (
                  <div className="inset danger mflow">
                    <p className="lead">
                      Permanently deletes {m.name}&rsquo;s {formatCount(m.eventCount ?? 0)} archived
                      event(s) and its directory entry, and re-seeds every client. Past ~30 days the
                      hub is the only holder of these rows.
                    </p>
                    {m.mergedInto !== null ? (
                      <p className="warnline">
                        This machine was merged into{" "}
                        {resolveMergeTargetName(m, machines) ?? "another machine"} — its events
                        render under that name and will disappear from it.
                      </p>
                    ) : null}
                    {stillSharing(m) ? (
                      <p className="warnline">
                        This machine is live and sharing — recent events will return unless sharing
                        is turned off on it first.
                      </p>
                    ) : null}
                    <div className="btns" style={{ alignSelf: "stretch" }}>
                      <input
                        className="input"
                        value={purgeConfirm}
                        onChange={(e) => setPurgeConfirm(e.target.value)}
                        placeholder={`Type "${m.name}" to confirm`}
                        aria-label="purge confirmation"
                        style={{ flex: 1 }}
                      />
                      <button
                        type="button"
                        className="chip danger"
                        disabled={purge.isPending || purgeConfirm !== m.name}
                        onClick={() =>
                          purge.mutate(
                            { machineId: m.machineId },
                            {
                              onSuccess: () => {
                                closeFlow();
                                showToast("Machine purged");
                              },
                            },
                          )
                        }
                      >
                        {purge.isPending ? "Purging…" : "Purge"}
                      </button>
                      <button type="button" className="chip ghost-btn" onClick={closeFlow}>
                        Cancel
                      </button>
                    </div>
                    {purge.isError ? <p className="err">{purge.error.message}</p> : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

// The glass select's soft caret (the .select-wrap overlay).
function CaretIcon(): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
