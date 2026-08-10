import { FolderOpen, Plus, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { insideTauri } from "@/lib/tauri";

// PathList — the editable list of Claude data roots (`settings.claudePaths`,
// ADR-0014), worn as the T7 glass recipe: rows are flat tint leafs (data rows
// are never frosted — the blur budget), reveal/remove icon buttons, an "Add
// path" chip, and the no-paths case as a T1 warn inset.
//
// The dialog/opener plugin calls throw outside a Tauri host (standalone Vite),
// so the two plugin-backed buttons ("Add path", "Open in <file manager>") are
// rendered `disabled` + dimmed there — a legible degraded state rather than a
// dead click. The remove button is pure JS and stays live under Vite.

// "Finder" on macOS, "Explorer" on Windows, "file manager" elsewhere — the
// label on the reveal button. Resolved once at module load.
const FILE_MANAGER =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
    ? "Finder"
    : typeof navigator !== "undefined" && /Win/i.test(navigator.platform)
      ? "Explorer"
      : "file manager";

export function PathList({
  paths,
  onChange,
}: {
  paths: string[];
  onChange: (next: string[]) => void;
}): React.ReactElement {
  // The folder picker / reveal-in-file-manager plugins need a Tauri host.
  const tauriHost = insideTauri();

  const addPath = async (): Promise<void> => {
    if (!insideTauri()) return;
    try {
      const picked = await open({ directory: true, multiple: false });
      // `open` returns null on cancel, a string for a single directory.
      if (typeof picked !== "string") return;
      if (paths.includes(picked)) return;
      onChange([...paths, picked]);
    } catch (err) {
      console.error("[settings] add path failed:", err);
    }
  };

  const removePath = (path: string): void => {
    onChange(paths.filter((p) => p !== path));
  };

  return (
    <>
      {paths.length === 0 ? (
        <div className="inset warn self-stretch">
          <p className="lead">
            No Claude data paths configured. Add one above, or reset to defaults.
          </p>
        </div>
      ) : (
        <ul className="paths">
          {paths.map((path) => (
            <li key={path} className="path-row">
              <span className="p" title={path}>
                {path}
              </span>
              <button
                type="button"
                className="path-btn"
                disabled={!tauriHost}
                title={
                  tauriHost
                    ? `Open in ${FILE_MANAGER}`
                    : `Opening in ${FILE_MANAGER} needs the desktop app`
                }
                aria-label={`Open ${path} in ${FILE_MANAGER}`}
                onClick={() => {
                  openPath(path).catch((err: unknown) => {
                    console.error("[settings] reveal path failed:", err);
                  });
                }}
              >
                <FolderOpen aria-hidden />
              </button>
              <button
                type="button"
                className="path-btn rm"
                title="Remove path"
                aria-label={`Remove ${path}`}
                onClick={() => removePath(path)}
              >
                <X aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="chip"
        disabled={!tauriHost}
        title={tauriHost ? undefined : "Adding a path needs the desktop app"}
        onClick={() => void addPath()}
      >
        <Plus aria-hidden />
        Add path
      </button>
    </>
  );
}
