import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { deriveProjectPath, type ProjectAnchorSnapshot } from "@maxprice/shared";
import type { IdentityIndex } from "@/lib/project-identity";
import { showToast } from "@/lib/toast";
import { useProjectMerge } from "@/state/use-project-merges";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSource: ProjectAnchorSnapshot | null;
  catalog: readonly ProjectAnchorSnapshot[];
  identity: IdentityIndex;
  onMerged: (target: ProjectAnchorSnapshot) => void;
};

function trailingParts(path: string): string[] {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .map((part) => part.toLocaleLowerCase());
}

function candidateSuggestion(
  source: ProjectAnchorSnapshot,
  candidate: ProjectAnchorSnapshot,
): { rank: number; reason: string | null } {
  const sourceParts = trailingParts(source.path);
  const candidateParts = trailingParts(candidate.path);
  const sourceBase = sourceParts.at(-1);
  const candidateBase = candidateParts.at(-1);
  if (sourceBase === undefined || sourceBase !== candidateBase) {
    return { rank: 10_000, reason: null };
  }
  let matching = 0;
  while (
    matching < sourceParts.length &&
    matching < candidateParts.length &&
    sourceParts[sourceParts.length - 1 - matching] ===
      candidateParts[candidateParts.length - 1 - matching]
  ) {
    matching += 1;
  }
  return {
    rank: 100 - matching,
    reason: matching > 1 ? "same trailing path" : "same directory name",
  };
}

function TwoClickConfirmButton({
  label,
  confirmLabel,
  disabled,
  resetKey,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  disabled?: boolean;
  resetKey: string;
  onConfirm: () => void;
}): React.ReactElement {
  const [armed, setArmed] = useState(false);
  useEffect(() => setArmed(false), [resetKey]);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 5_000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  return (
    <button
      type="button"
      className={cn("chip project-merge-confirm", armed && "armed")}
      disabled={disabled}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

function snapshotLabel(snapshot: ProjectAnchorSnapshot): string {
  return `${snapshot.name} — ${deriveProjectPath(snapshot.path)}`;
}

type ProjectPickerOption = {
  snapshot: ProjectAnchorSnapshot;
  reason?: string | null;
};

function ProjectPicker({
  label,
  placeholder,
  options,
  value,
  disabled = false,
  onChange,
}: {
  label: string;
  placeholder: string;
  options: readonly ProjectPickerOption[];
  value: string;
  disabled?: boolean;
  onChange: (anchor: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.snapshot.anchor === value) ?? null;
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (normalized === "") return options;
    return options.filter((option) => {
      const searchable = `${snapshotLabel(option.snapshot)} ${option.reason ?? ""}`;
      return searchable.toLocaleLowerCase().includes(normalized);
    });
  }, [options, query]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        className={cn("chip select project-merge-picker", selected === null && "placeholder")}
        aria-label={label}
        aria-haspopup="listbox"
        disabled={disabled}
      >
        <span className="truncate">
          {selected ? snapshotLabel(selected.snapshot) : placeholder}
        </span>
        <ChevronDown aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="menu project-merge-menu w-[var(--radix-popover-trigger-width)] gap-0 rounded-[14px] border-[var(--panel-border)] p-[5px] shadow-none ring-0"
      >
        <input
          className="input mb-1"
          aria-label={`Search ${label.toLocaleLowerCase()}`}
          placeholder="Search projects…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ul role="listbox" aria-label={label} className="project-merge-options">
          {visible.length === 0 ? (
            <li className="px-2 py-1.5 text-[12px] text-soft">No projects found</li>
          ) : (
            visible.map((option) => {
              const isSelected = option.snapshot.anchor === value;
              return (
                <li key={option.snapshot.anchor} role="option" aria-selected={isSelected}>
                  <button
                    type="button"
                    className={cn("opt", isSelected && "checked")}
                    onClick={() => {
                      onChange(option.snapshot.anchor);
                      setOpen(false);
                    }}
                  >
                    <span className="box" aria-hidden>
                      <Check strokeWidth={3.5} />
                    </span>
                    <span className="truncate">{snapshotLabel(option.snapshot)}</span>
                    {option.reason ? <em>Suggested · {option.reason}</em> : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export function ProjectMergeDialog({
  open,
  onOpenChange,
  initialSource,
  catalog,
  identity,
  onMerged,
}: Props): React.ReactElement {
  const mutation = useProjectMerge();
  const resetMutation = mutation.reset;
  const [sourceAnchor, setSourceAnchor] = useState(initialSource?.anchor ?? "");
  const [targetAnchor, setTargetAnchor] = useState("");

  const completeCatalog = useMemo(() => {
    const byAnchor = new Map(catalog.map((snapshot) => [snapshot.anchor, snapshot]));
    return [...byAnchor.values()].sort((a, b) =>
      a.name === b.name ? a.path.localeCompare(b.path) : a.name.localeCompare(b.name),
    );
  }, [catalog]);

  useEffect(() => {
    if (!open) return;
    setSourceAnchor(initialSource?.anchor ?? "");
    setTargetAnchor("");
    resetMutation();
  }, [open, initialSource, resetMutation]);

  const source = completeCatalog.find((entry) => entry.anchor === sourceAnchor) ?? null;
  const targets = useMemo(() => {
    if (source === null) return [];
    return completeCatalog
      .filter(
        (candidate) =>
          candidate.anchor !== source.anchor &&
          identity.keyOf(candidate.anchor) !== identity.keyOf(source.anchor),
      )
      .map((candidate) => ({ candidate, ...candidateSuggestion(source, candidate) }))
      .sort((a, b) =>
        a.rank === b.rank
          ? snapshotLabel(a.candidate).localeCompare(snapshotLabel(b.candidate))
          : a.rank - b.rank,
      );
  }, [completeCatalog, identity, source]);
  const target =
    targets.find((entry) => entry.candidate.anchor === targetAnchor)?.candidate ?? null;
  const differentRepos =
    source !== null &&
    target !== null &&
    identity.automaticKeyOf(source.anchor) !== source.anchor &&
    identity.automaticKeyOf(target.anchor) !== target.anchor &&
    identity.automaticKeyOf(source.anchor) !== identity.automaticKeyOf(target.anchor);

  const submitMerge = (): void => {
    if (source === null || target === null) return;
    void mutation
      .mutateAsync({ source, target })
      .then(() => {
        showToast(`Merged ${source.name} into ${target.name}`);
        onMerged(target);
        onOpenChange(false);
      })
      .catch(() => {});
  };

  const unmerge = (sourceSnapshot: ProjectAnchorSnapshot): void => {
    void mutation
      .mutateAsync({ source: sourceSnapshot, target: null })
      .then(() => showToast(`Unmerged ${sourceSnapshot.name}`))
      .catch(() => {});
  };

  const entries = identity.mergeEntries;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) mutation.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="project-merge-dialog">
        <DialogTitle>Project merge assertions</DialogTitle>
        <DialogDescription>
          Tell MaxPrice that two project histories belong together. Files and session records stay
          unchanged; this only changes how project-facing totals are grouped.
        </DialogDescription>

        <div className="project-merge-form">
          <label>
            <span>Source project</span>
            {initialSource === null ? (
              <ProjectPicker
                label="Source project"
                placeholder="Choose a source…"
                options={completeCatalog.map((snapshot) => ({ snapshot }))}
                value={sourceAnchor}
                onChange={(anchor) => {
                  setSourceAnchor(anchor);
                  setTargetAnchor("");
                }}
              />
            ) : (
              <span className="project-merge-picked">
                <b>{initialSource.name}</b>
                <small className="num">{initialSource.path}</small>
              </span>
            )}
          </label>

          <label>
            <span>Merge into</span>
            <ProjectPicker
              label="Retained project"
              placeholder="Choose the retained project…"
              options={targets.map(({ candidate, reason }) => ({ snapshot: candidate, reason }))}
              value={targetAnchor}
              disabled={source === null}
              onChange={setTargetAnchor}
            />
          </label>

          {differentRepos ? (
            <div className="inset warn" role="status">
              Both projects have different Git repository identities. Merge only if that automatic
              evidence is incomplete or no longer represents the history you want grouped.
            </div>
          ) : null}

          <div className="project-merge-actions">
            <button type="button" className="chip" onClick={() => onOpenChange(false)}>
              Cancel
            </button>
            <TwoClickConfirmButton
              label="Merge projects"
              confirmLabel="Click again to merge"
              disabled={target === null || mutation.isPending}
              resetKey={`${sourceAnchor}\u0000${targetAnchor}\u0000${open}`}
              onConfirm={submitMerge}
            />
          </div>
        </div>

        {mutation.error ? (
          <div className="inset danger" role="alert">
            <p className="lead">Couldn&apos;t save the project merge</p>
            <p>{mutation.error.message}</p>
          </div>
        ) : null}

        {identity.conflicts.length > 0 ? (
          <div className="inset warn project-merge-conflicts">
            <p className="lead">Merge conflict needs attention</p>
            <p>The newest assertion that would close each cycle is currently ignored.</p>
          </div>
        ) : null}

        {entries.length > 0 ? (
          <section className="project-merge-list" aria-label="Existing project merges">
            <h3>Existing assertions</h3>
            {entries.map((entry) => {
              const targetSnapshot = entry.assertion.target;
              return (
                <div
                  className={cn("project-merge-row", entry.status === "conflict" && "conflict")}
                  key={`${entry.assertion.authorMachineId}:${entry.assertion.source.anchor}`}
                >
                  <span className="project-merge-picked">
                    <b>{entry.assertion.source.name}</b>
                    <small>
                      {entry.status === "conflict"
                        ? "Conflict — ignored"
                        : entry.status === "unmerged"
                          ? "Unmerged"
                          : entry.status === "redundant"
                            ? "Also matched automatically"
                            : `Merged into ${targetSnapshot?.name ?? "unknown"}`}
                    </small>
                  </span>
                  {entry.status === "unmerged" ? null : (
                    <TwoClickConfirmButton
                      label={entry.status === "conflict" ? "Resolve" : "Unmerge"}
                      confirmLabel={
                        entry.status === "conflict"
                          ? "Click again to resolve"
                          : "Click again to unmerge"
                      }
                      disabled={mutation.isPending}
                      resetKey={`${entry.assertion.updatedAt}:${open}`}
                      onConfirm={() => unmerge(entry.assertion.source)}
                    />
                  )}
                </div>
              );
            })}
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
