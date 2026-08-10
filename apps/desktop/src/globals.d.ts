// Compile-time constants injected by Vite's `define` (see vite.config.ts).

// The desktop app version, baked in from apps/desktop/package.json at build
// time. Surfaced by Settings › App info — it IS the Version row, and it is the
// comparand the Engine row checks the sidecar's `engineVersion` against, so a
// mismatch names a stale `bun run build:binaries`.
declare const __APP_VERSION__: string;
