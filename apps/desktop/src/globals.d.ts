// Compile-time constants injected by Vite: its `define` (see vite.config.ts)
// and the `VITE_*` env it inlines into `import.meta.env`.

// The desktop app version, baked in from apps/desktop/package.json at build
// time. Surfaced by Settings › App info — it IS the Version row, and it is the
// comparand the Engine row checks the sidecar's `engineVersion` against, so a
// mismatch names a stale `bun run build:binaries`.
declare const __APP_VERSION__: string;

// The renderer-only Vite rig's env (CLAUDE.md, "Frontend debug workflow"). Both
// are read only outside Tauri: `VITE_SIDECAR_URL` names a standalone sidecar
// (`lib/sidecar.ts`), and `VITE_DEV_SETTINGS` seeds the in-memory settings
// (`state/use-settings.ts`).
interface ImportMetaEnv {
  readonly VITE_SIDECAR_URL?: string;
  readonly VITE_DEV_SETTINGS?: string;
}
