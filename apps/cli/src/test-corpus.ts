import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slugFromPath, ymdShift, zonedInstant } from "@maxprice/shared";

// A synthetic two-Organization corpus for the report commands' tests and the
// Headless client's acceptance rig (scripts/acceptance/headless/). Every
// timestamp is relative to `now`, so the default range, this week, always
// holds usage. Nothing here is real: invented paths, ids and models.
//
// - The corpus's days are counted in Chicago (`corpusDay`), the zone the
//   tests and the rig's rows ask "this week" and "today" in, so its today is
//   theirs at every hour of the Chicago day it is written on. Its wall-clock
//   times are New York's, which is an hour ahead: counted there, from
//   midnight to 01:00 the corpus's today was Chicago's tomorrow, and every
//   this-week and popout answer lost its active block, and every this-week
//   answer its sessions last active today. The corpus alone still ages at
//   Chicago midnight. Amended 2026-10-20 (PR #522): the headless rig and the
//   report tests use test-clock.ts's advancing Chicago-noon origin in
//   their own process and every sandboxed child, with a ten-minute budget.
// - Home is HOME_ORG, and TRACKED_ORG is tracked beside it. EXCLUDED_ORG's
//   usage is written too, and never enters the store (ADR-0098).
// - Two projects share the folder name `alpha`, so the name alone is
//   ambiguous; `alpha` under /home/dev also has a worktree.
// - Each day carries an event at 00:30 in New York, which is 23:30 the day
//   before in Chicago in every season, and one at 20:30 there, which is the
//   next day in UTC, so each of the three zones buckets the corpus its own
//   way; the day's third event, at 10:10 there, all three agree on.
// - Three sessions end before today (`corpusSessionEnds`): one outside any
//   week, and two on `ZONE_DAY` at times Chicago, New York and UTC date
//   differently, so the sessions report's range and zone rows have answers
//   that differ.

export const HOME_ORG = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
export const TRACKED_ORG = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
export const EXCLUDED_ORG = "cccccccc-3333-4333-8333-cccccccccccc";

export const PROJECTS = {
  alpha: "/home/dev/git/alpha",
  alphaWorktree: "/home/dev/git/alpha/.claude/worktrees/feature",
  otherAlpha: "/srv/work/alpha",
  beta: "/home/dev/git/beta",
  gamma: "/home/dev/git/gamma",
  // The peer machine's only project.
  delta: "/home/dev/git/delta",
} as const;

export const MODELS = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5-1",
} as const;

type Session = {
  id: string;
  cwd: string;
  organization: string;
  // Events: days before the corpus's today (`corpusDay`), a wall-clock time
  // in New York (ms since midnight) and a model.
  events: { daysAgo: number; at: number; model: string }[];
};

const BOUNDARY_ZONE = "America/New_York";
const AT_00_30 = 30 * 60_000;
const AT_10_10 = (10 * 60 + 10) * 60_000;
const AT_20_30 = (20 * 60 + 30) * 60_000;

const DAYS = [0, 1, 2, 3, 5, 9];

// The day, in days before the corpus's today, on which the corpus's sessions
// end at times each zone dates differently (the rig's one-day zone rows).
export const ZONE_DAY = 2;

// The zone the corpus's days are counted in: the tests' and the rig's.
const DAY_ZONE = "America/Chicago";

// A corpus day, `daysAgo` before the corpus's today at `now`, as YYYYMMDD.
// Its events are at New York wall-clock times on that date.
export function corpusDay(daysAgo: number, now: number): string {
  return ymdShift(-daysAgo, DAY_ZONE, now);
}

function sessions(): Session[] {
  const out: Session[] = [];
  const spread = (id: string, cwd: string, organization: string, models: string[]): void => {
    out.push({
      id,
      cwd,
      organization,
      events: DAYS.flatMap((daysAgo, d) => [
        { daysAgo, at: AT_00_30, model: models[d % models.length]! },
        { daysAgo, at: AT_10_10, model: models[(d + 1) % models.length]! },
        { daysAgo, at: AT_20_30, model: models[(d + 2) % models.length]! },
      ]),
    });
  };
  spread("sess-alpha", PROJECTS.alpha, HOME_ORG, [MODELS.opus, MODELS.sonnet]);
  spread("sess-alpha-wt", PROJECTS.alphaWorktree, HOME_ORG, [MODELS.sonnet, MODELS.haiku]);
  spread("sess-other-alpha", PROJECTS.otherAlpha, HOME_ORG, [MODELS.haiku]);
  spread("sess-beta-home", PROJECTS.beta, HOME_ORG, [MODELS.fable, MODELS.opus]);
  spread("sess-beta-tracked", PROJECTS.beta, TRACKED_ORG, [MODELS.opus, MODELS.haiku]);
  spread("sess-gamma", PROJECTS.gamma, TRACKED_ORG, [MODELS.sonnet]);
  spread("sess-excluded", PROJECTS.gamma, EXCLUDED_ORG, [MODELS.opus]);
  // `/api/sessions` picks sessions by their last activity, so every session
  // above, last active today, answers any range that holds today alike.
  // These end earlier: one nine days back, outside any week, and two on the
  // zone day two days back, one at 00:30 in New York (the day before in
  // Chicago and Los Angeles) and one at 20:30 there (the day after in UTC).
  const once = (id: string, daysAgo: number, at: number, model: string): void => {
    out.push({ id, cwd: PROJECTS.beta, organization: HOME_ORG, events: [{ daysAgo, at, model }] });
  };
  once("sess-old", 9, AT_10_10, MODELS.opus);
  once("sess-dawn", ZONE_DAY, AT_00_30, MODELS.sonnet);
  once("sess-dusk", ZONE_DAY, AT_20_30, MODELS.haiku);
  return out;
}

// Each session's last event, as an ISO timestamp: what a session's last
// activity is read from.
export function corpusSessionEnds(now: number = Date.now()): { id: string; end: string }[] {
  return sessions().map((session) => ({
    id: session.id,
    end: session.events
      .map((event) => timestamp(event, now))
      .sort()
      .at(-1)!,
  }));
}

// Every event's instant, as an ISO timestamp.
export function corpusTimestamps(now: number = Date.now()): string[] {
  return sessions().flatMap((session) => session.events.map((event) => timestamp(event, now)));
}

function timestamp(event: Session["events"][number], now: number): string {
  return new Date(
    zonedInstant(corpusDay(event.daysAgo, now), event.at, BOUNDARY_ZONE),
  ).toISOString();
}

// The several-Account corpus (#642), for the rig's accounts phase: the main
// corpus's sessions, each Owner record naming an Account (ADR-0137 §2: an
// Owner record's `ownerAccountUuid` is an event's Account evidence) but
// `sess-beta-home`'s, whose usage stays the usage whose Account is not
// known, and three sessions of its own:
// - `sess-third`, Blair's in THIRD_ORG, active nine days back and today, so a
//   range from day 5 holds it whole as a session (its last activity) but only
//   today's part as a project's usage: the sessions Total the Projects strip
//   gives differs from its rows' sum;
// - `sess-casey`, Casey's in Home, whose usage an Excluded account never
//   lets into the store (ADR-0136 §3);
// - nothing else changes a main-corpus answer: the main phases never write
//   this variant.
// Alex is the Home membership's Account, Blair a second tracked Account,
// Casey an Excluded one. All three, and THIRD_ORG, are synthetic.
export const ALEX = "11111111-aaaa-4aaa-8aaa-111111111111";
export const BLAIR = "22222222-bbbb-4bbb-8bbb-222222222222";
export const CASEY = "33333333-cccc-4ccc-8ccc-333333333333";
export const THIRD_ORG = "dddddddd-4444-4444-8444-dddddddddddd";

// Each main-corpus session's Account in the accounts variant; absent, none.
const SESSION_ACCOUNTS: Readonly<Record<string, string>> = {
  "sess-alpha": ALEX,
  "sess-alpha-wt": ALEX,
  "sess-other-alpha": BLAIR,
  "sess-beta-tracked": BLAIR,
  "sess-gamma": ALEX,
  "sess-excluded": ALEX,
  "sess-old": ALEX,
  "sess-dawn": ALEX,
  "sess-dusk": ALEX,
};

type AccountSession = Session & { account?: string };

function accountSessions(): AccountSession[] {
  return [
    ...sessions().map((session) => ({ ...session, account: SESSION_ACCOUNTS[session.id] })),
    {
      id: "sess-third",
      cwd: PROJECTS.gamma,
      organization: THIRD_ORG,
      account: BLAIR,
      events: [
        { daysAgo: 9, at: AT_10_10, model: MODELS.opus },
        { daysAgo: 0, at: AT_10_10, model: MODELS.sonnet },
        { daysAgo: 0, at: AT_20_30, model: MODELS.opus },
      ],
    },
    {
      id: "sess-casey",
      cwd: PROJECTS.beta,
      organization: HOME_ORG,
      account: CASEY,
      events: DAYS.map((daysAgo) => ({ daysAgo, at: AT_10_10, model: MODELS.haiku })),
    },
  ];
}

// The accounts variant's sessions by the Account their Owner record names
// (null: none), for a test that counts what each Scope holds.
export function accountCorpusSessions(): {
  id: string;
  organization: string;
  account: string | null;
}[] {
  return accountSessions().map((s) => ({
    id: s.id,
    organization: s.organization,
    account: s.account ?? null,
  }));
}

// A second machine's corpus, for the rig's fleet phase: one Home session in
// a project of its own, so a machine filter changes what a report shows.
function peerSessions(): Session[] {
  return [
    {
      id: "sess-peer",
      cwd: PROJECTS.delta,
      organization: HOME_ORG,
      events: DAYS.map((daysAgo) => ({ daysAgo, at: AT_10_10, model: MODELS.opus })),
    },
  ];
}

export type CorpusVariant = "main" | "peer" | "accounts";

// Each session file's contents, at `<projects dir>/<slug>/<session>.jsonl`,
// each opening with the Owner record that attributes its usage. `peer` gives
// the second machine's instead, and `accounts` the several-Account corpus,
// whose Owner records name an Account too.
export function corpusFiles(
  now: number,
  which: CorpusVariant = "main",
): { slug: string; sessionId: string; text: string }[] {
  const chosen: AccountSession[] =
    which === "main" ? sessions() : which === "peer" ? peerSessions() : accountSessions();
  return chosen.map((session) => {
    const owner = {
      type: "bridge-session",
      sessionId: session.id,
      ownerOrganizationUuid: session.organization,
      ...(session.account === undefined ? {} : { ownerAccountUuid: session.account }),
      timestamp: "1970-01-01T00:00:00.000Z",
    };
    const lines = session.events.map((event, i) => ({
      type: "assistant",
      cwd: session.cwd,
      sessionId: session.id,
      requestId: `req-${session.id}-${i}`,
      uuid: `${session.id}-evt-${i}`,
      timestamp: timestamp(event, now),
      message: {
        id: `msg-${session.id}-${i}`,
        model: event.model,
        usage: {
          input_tokens: 10 + i,
          output_tokens: 300 + 7 * i,
          cache_creation_input_tokens: 2_000 + 13 * i,
          cache_read_input_tokens: 40_000 + 101 * i,
        },
      },
    }));
    return {
      slug: slugFromPath(session.cwd),
      sessionId: session.id,
      text: [owner, ...lines].map((line) => JSON.stringify(line)).join("\n") + "\n",
    };
  });
}

// Writes the corpus (`corpusFiles`) under `<claudeConfigDir>/projects/`.
export function writeCorpus(
  claudeConfigDir: string,
  now: number = Date.now(),
  which: CorpusVariant = "main",
): void {
  for (const { slug, sessionId, text } of corpusFiles(now, which)) {
    const dir = join(claudeConfigDir, "projects", slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), text);
  }
}
