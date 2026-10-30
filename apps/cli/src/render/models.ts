import { normalizeModelName } from "@maxprice/shared";
import type { Style } from "./style";

// Model families as the reports print them: the text the Desktop's model
// badges name, and each family's colour on a terminal.

const FAMILY_PAINT: Record<string, (s: Style) => (text: string) => string> = {
  fable: (s) => s.yellow,
  opus: (s) => s.magenta,
  sonnet: (s) => s.blue,
  haiku: (s) => s.green,
};

// A row's model families, as the Desktop's model badges list them: each
// family once, in first-seen order, lowercased.
export function modelFamilies(modelsUsed: readonly string[]): string {
  return [...new Set(modelsUsed.map(normalizeModelName))].map((f) => f.toLowerCase()).join(" ");
}

// One lowercased family in its colour; anything else gray.
export function paintFamily(family: string, s: Style): string {
  return (FAMILY_PAINT[family] ?? (() => s.gray))(s)(family);
}

// `modelFamilies` text, each family in its colour.
export function paintModels(text: string, s: Style): string {
  return text
    .split(" ")
    .map((word) => paintFamily(word, s))
    .join(" ");
}
