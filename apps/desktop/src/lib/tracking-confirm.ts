import {
  checkLabel,
  LABEL_MAX,
  type HubConnection,
  type OrganizationEntry,
  type UsageConnection,
} from "@maxprice/shared";

// Settings › Accounts' words around tracking and renaming (#639; moved from
// the Organizations list's view, which the Account cards replaced): what the
// track confirmation says about an Organization, and how a typed rename or
// Account label is submitted. Pure, so their tests need no hooks.

// What the track and exclude confirmations say, from what tracking an
// Organization changes on this machine. The exclude confirmation's words
// (`excludeCopy`, packages/shared) read `hub` alone.
export interface TrackingFacts {
  // It has usage on this machine (`seenOn.machine`).
  local: boolean;
  // A hub is configured, connected or not.
  hub: boolean;
  // What its limits will be once tracked, when limits can be read now: with
  // this machine's key (a reading error is not the key failing), or by the
  // Hub. null when nothing can be read, or its answer says nothing either way.
  limits: "polled" | "unreadable" | "unlisted" | null;
}

export function trackingFacts(
  entry: OrganizationEntry,
  key: UsageConnection,
  hubConnection: HubConnection,
  hubSourced: boolean,
): TrackingFacts {
  const readable = hubSourced || key === "connected" || key === "error";
  return {
    local: entry.seenOn.machine,
    hub: hubConnection !== "off",
    limits: readable ? trackedLimits(entry) : null,
  };
}

function trackedLimits(entry: OrganizationEntry): TrackingFacts["limits"] {
  if (entry.limits === null) return entry.seenOn.account ? null : "unlisted";
  switch (entry.limits.answer) {
    case "windows":
    case "none":
      return "polled";
    case "forbidden":
      return "unreadable";
    case "error":
      return null;
  }
}

// The track confirmation's paragraphs. Neither limits sentence names a key:
// the Hub's may be the one reading.
export function trackCopy(facts: TrackingFacts): string[] {
  const copy = [
    facts.local
      ? "MaxPrice reads its history from the Claude Code session files still on this machine and counts it in every report. History whose session files are gone can't be counted."
      : "This machine has no usage for it yet. Any that appears is counted in every report.",
  ];
  if (facts.hub && facts.local) {
    copy.push(
      "Its usage here is also shared with your hub, where other machines that track it can see it.",
    );
  }
  switch (facts.limits) {
    case "polled":
      copy.push("Its limits are read once a minute.");
      break;
    case "unreadable":
      copy.push("Its limits can't be read.");
      break;
    case "unlisted":
      copy.push("It isn't on this account's list, so its limits can't be read.");
      break;
    case null:
      break;
  }
  return copy;
}

// The track confirmation's title: the Organization as Settings shows it.
export function trackTitle(label: string): string {
  return `Track ${label}?`;
}

export type RenameSubmission =
  | { kind: "noop" }
  // null clears the rename.
  | { kind: "put"; label: string | null }
  | { kind: "invalid"; error: string };

// What saving a rename draft does: an Organization's rename (ADR-0105) or an
// Account label (ADR-0136 §7), whose rules match. `bareLabel` is the user's
// label as it stands, `renamed` whether there is one. The sidecar also
// refuses a label another Organization (or Account) already uses
// (case-insensitively); that refusal arrives from the PUT.
export function renameSubmission(
  draft: string,
  row: { bareLabel: string; renamed: boolean },
): RenameSubmission {
  const trimmed = draft.trim();
  if (trimmed === "") return row.renamed ? { kind: "put", label: null } : { kind: "noop" };
  if (row.renamed && trimmed === row.bareLabel) return { kind: "noop" };
  const check = checkLabel(trimmed);
  if (!check.ok) {
    return { kind: "invalid", error: `Use ${LABEL_MAX} characters or fewer.` };
  }
  return { kind: "put", label: check.label };
}

// A rename refusal as the inline error shows it: the sidecar's refusals are
// lowercase fragments ("another organization already uses that label"), so
// the first letter is capitalized and a closing period added.
export function refusalSentence(message: string): string {
  const text = message.trim();
  if (text === "") return text;
  const capitalized = text[0]!.toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}
