import { normalizeHubUrl } from "@maxprice/shared";

// ADR-0121 §8–9: the Hub URL for warnings, the serve log and status, never
// userinfo from a hand-edited settings.json. Unparseable text is withheld entirely:
// it can contain credentials too, without an authority we can safely strip.
// The boot still gets `joinedHubUrl`'s normalize-or-raw value.
export function displayHubUrl(hubUrl: string): string | null {
  if (hubUrl.trim() === "") return null;
  try {
    const url = new URL(normalizeHubUrl(hubUrl));
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "(invalid Hub URL)";
  }
}
