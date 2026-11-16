import { STORAGE_COPY } from "./storage-view";

// Settings' section titles, in page order: the one list `Settings.tsx`'s
// `<Section title=…>` and the ⌘K finder's Settings results (`finderSettings`)
// both read, so a renamed section moves its finder result and anchor with it.
// The two Storage titles stay `STORAGE_COPY`'s, which owns that cluster's copy.
export const SETTINGS_SECTIONS = {
  // The Accounts cluster, first on the page (#621, #639): its eyebrow is
  // `SETTINGS_ACCOUNTS_ANCHOR`'s, not a section of its own.
  homeMembership: "Home membership",
  claude: "Claude",
  gateways: "Gateways",
  unattributedUsage: "Unattributed usage",
  claudePaths: "Claude data paths",
  timezone: "Timezone",
  week: "Week",
  costMode: "Cost mode",
  currency: "Currency",
  diskUsage: STORAGE_COPY.title,
  cleanUp: STORAGE_COPY.actTitle,
  usageHub: "Usage hub",
  background: "Background",
  autostart: "Start at login",
  updates: "Updates",
  pricing: "Pricing",
  transparency: "Reduce transparency",
  reset: "Reset",
  appInfo: "App info",
} as const;

export type SettingsSectionKey = keyof typeof SETTINGS_SECTIONS;

// A Settings section's anchor id, from its title: the `id` its Section
// renders, and the hash the finder opens it by (`/settings#settings-…`).
export function settingsSectionId(title: string): string {
  return `settings-${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}
