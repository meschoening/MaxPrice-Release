// Translate the shared status helpers' Tailwind dot classes (`bg-good` /
// `bg-warn` / `bg-bad`, null for the unconfigured state) into the glass
// `.dot` triad variants (T1: tint + halo ring). The semantic state → color
// mapping stays centralized in usage-status.ts / this app's presentation.ts;
// this is presentation-only translation. Kept in lockstep with
// apps/desktop/src/lib/dot-variant.ts.
const DOT_VARIANT: Record<string, "good" | "warn" | "bad"> = {
  "bg-good": "good",
  "bg-warn": "warn",
  "bg-bad": "bad",
};

export function dotVariant(dotClass: string | null): "good" | "warn" | "bad" | "soft" {
  return (dotClass !== null ? DOT_VARIANT[dotClass] : undefined) ?? "soft";
}
