import pkg from "../package.json";

// The version this `maxprice` reports and compares (ADR-0118 §6): `--version`
// prints it, and the daemon client requires the daemon's `engineVersion` to
// equal it (ADR-0119 §5). `bun build --compile` inlines the package.json, so
// it is the version the binary was built at. `scripts/version-files.ts` lists
// the file as `baked`.
export const VERSION: string = pkg.version;
