// Translate the shared status helpers' Tailwind dot classes (`bg-good` /
// `bg-warn` / `bg-bad`, null for the unconfigured state) into the glass
// `.dot` triad variants (T1: tint + halo ring). The semantic state → color
// mapping stays centralized in usage-status.ts / hub-status.ts; this is
// presentation-only translation for the M6 status lines.
const DOT_VARIANT: Record<string, "good" | "warn" | "bad"> = {
  "bg-good": "good",
  "bg-warn": "warn",
  "bg-bad": "bad",
};

export type DotVariant = "good" | "warn" | "bad" | "soft";

export function dotVariant(dotClass: string | null): DotVariant {
  return (dotClass !== null ? DOT_VARIANT[dotClass] : undefined) ?? "soft";
}
