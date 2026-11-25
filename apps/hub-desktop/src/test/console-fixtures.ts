import {
  HUB_PROTOCOL_VERSION,
  type HubAccount,
  type HubLabelDirectory,
  type HubMachine,
  type HubMembership,
  type HubOrganization,
  type HubStatus,
  type UsageConnection,
} from "@maxprice/shared";

// The Hub console's fixtures for several Accounts (#641), after the throwaway
// prototype's (#614: `0`, `1`, `1m`, `3c`, `14c`), as Hub data: the status, the
// Organization roster, the Label directory and the Machine directory a Hub
// would answer. The component tests and the console stills rig
// (scripts/acceptance/hub-console/) read them. `3t` and `14t` hold a ChatGPT
// Account, which v7 cannot carry (ADR-0136 §1), so they are not here. Every
// name is made up.

export const FIXTURE_NOW = Date.parse("2026-11-02T15:00:00.000Z");
const ago = (minutes: number): string => new Date(FIXTURE_NOW - minutes * 60_000).toISOString();
// A window's reset an hour or a few days ahead, so a reading is live.
const FIVE_HOUR_RESET = new Date(FIXTURE_NOW + 2 * 3_600_000).toISOString();
const WEEKLY_RESET = new Date(FIXTURE_NOW + 3 * 86_400_000).toISOString();

export type ConsoleFixture = {
  key: string;
  title: string;
  status: HubStatus;
  organizations: HubOrganization[];
  labels: HubLabelDirectory;
  machines: HubMachine[];
};

type Seat = {
  organization: string;
  // Percent per window, null for a window not in flight.
  fiveHour: number | null;
  weekly: number | null;
  limits?: HubMembership["limits"];
};
type AccountSpec = {
  uuid: string;
  label: string | null;
  connection: UsageConnection;
  // Minutes since the key was set; null: no key on this Hub.
  setMinutesAgo: number | null;
  source?: string;
  seats: Seat[];
};

// Fixed ids, readable in a still: an Account's first 8 and an Organization's.
const ACCOUNT = {
  me: "a1b2c3d4-0000-4000-8000-000000000001",
  work: "b2c3d4e5-0000-4000-8000-000000000002",
  personal: "c3d4e5f6-0000-4000-8000-000000000003",
  ci: "d4e5f6a7-0000-4000-8000-000000000004",
  consulting: "e5f6a7b8-0000-4000-8000-000000000005",
  side: "f6a7b8c9-0000-4000-8000-000000000006",
} as const;
const ORGANIZATION: Record<string, string> = {
  "Home Lab": "11111111-0000-4000-8000-000000000001",
  "Acme Team": "22222222-0000-4000-8000-000000000002",
  Globex: "33333333-0000-4000-8000-000000000003",
  Initech: "44444444-0000-4000-8000-000000000004",
  "Acme CI": "55555555-0000-4000-8000-000000000005",
  Umbrella: "66666666-0000-4000-8000-000000000006",
  Hooli: "77777777-0000-4000-8000-000000000007",
  "Pied Piper": "88888888-0000-4000-8000-000000000008",
  "Stark Ind.": "99999999-0000-4000-8000-000000000009",
  "Wayne Ent.": "aaaaaaaa-0000-4000-8000-00000000000a",
  Tyrell: "bbbbbbbb-0000-4000-8000-00000000000b",
  // Named by no label: the side Account's event tag.
  unnamed: "9c1d2e3f-0000-4000-8000-00000000000c",
};

function membership(account: AccountSpec, seat: Seat): HubMembership {
  const organizationUuid = ORGANIZATION[seat.organization]!;
  if (account.setMinutesAgo === null) {
    // An Account named only by an event tag: its pair, never read.
    return {
      organizationUuid,
      limits: null,
      windowStates: null,
      lastReadAt: null,
      lastSampleAt: null,
    };
  }
  const limits = seat.limits ?? "windows";
  const read = limits === "windows" || limits === "none";
  const dead = account.connection === "expired";
  const readAt = dead ? ago(60 * 26) : ago(1);
  return {
    organizationUuid,
    limits,
    windowStates: read
      ? {
          fiveHour: seat.fiveHour === null ? "idle" : "active",
          weekly: seat.weekly === null ? "idle" : "active",
        }
      : null,
    lastReadAt: read ? readAt : null,
    lastSampleAt: read ? readAt : null,
    ...(limits === "windows"
      ? {
          current: {
            capturedAt: readAt,
            fiveHour:
              seat.fiveHour === null
                ? null
                : { utilizationPct: seat.fiveHour, resetAt: FIVE_HOUR_RESET },
            weekly:
              seat.weekly === null ? null : { utilizationPct: seat.weekly, resetAt: WEEKLY_RESET },
          },
        }
      : {}),
  } as HubMembership;
}

function account(spec: AccountSpec): HubAccount {
  return {
    provider: "anthropic",
    accountUuid: spec.uuid,
    connection: spec.connection,
    setAt: spec.setMinutesAgo === null ? null : ago(spec.setMinutesAgo),
    source: spec.setMinutesAgo === null ? null : (spec.source ?? "local"),
    removedAt: null,
    memberships: spec.seats
      .map((seat) => membership(spec, seat))
      .sort((a, b) => (a.organizationUuid < b.organizationUuid ? -1 : 1)),
  };
}

function machine(
  name: string,
  live: boolean,
  minutesAgo: number,
  home: { account: string; organization: string } | null,
): HubMachine {
  return {
    machineId: `m-${name}`,
    name,
    registeredAt: ago(60 * 24 * 60),
    mergedInto: null,
    homeMemberships:
      home === null
        ? null
        : {
            anthropic: {
              organizationUuid: ORGANIZATION[home.organization]!,
              accountUuid: home.account,
            },
          },
    live,
    lastSeenAt: ago(minutesAgo),
    eventCount: 1200 + name.length * 37,
    lastEventAt: ago(minutesAgo + 2),
    lastPushAt: live ? ago(minutesAgo + 1) : null,
  };
}

function fixture(
  key: string,
  title: string,
  specs: AccountSpec[],
  machines: HubMachine[],
): ConsoleFixture {
  const accounts = specs
    .map(account)
    .sort((a, b) => ((a.accountUuid ?? "") < (b.accountUuid ?? "") ? -1 : 1));
  const editedAt = ago(60 * 24);
  const named = new Set(specs.flatMap((s) => s.seats.map((seat) => seat.organization)));
  named.delete("unnamed");
  const organizations: HubOrganization[] = [...named].sort().map((label) => ({
    uuid: ORGANIZATION[label]!,
    label,
    renamed: true,
    listedBy: specs
      .filter(
        (s) => s.setMinutesAgo !== null && s.seats.some((seat) => seat.organization === label),
      )
      .map((s) => s.uuid)
      .sort(),
  }));
  return {
    key,
    title,
    status: {
      service: "maxprice-hub",
      protocolVersion: HUB_PROTOCOL_VERSION,
      accounts,
      samplesStampedAt: null,
      usageLastSampleAt: specs.length === 0 ? null : ago(1),
      sampleCount: specs.length * 640,
      startedAt: ago(60 * 24 * 3),
      passwordProtected: true,
      bindHosts: ["127.0.0.1", "100.101.102.103"],
      bindWarning: null,
      events: {
        epoch: "e-fixture",
        seq: 48_211,
        deletionGeneration: 0,
        eventCount: 48_211,
        fileBytes: 31_457_280,
        lastAppendAt: ago(1),
      },
    },
    organizations,
    labels: {
      organizations: Object.fromEntries(
        organizations.map((row) => [row.uuid, { label: row.label, editedAt }]),
      ),
      accounts: Object.fromEntries(
        specs.filter((s) => s.label !== null).map((s) => [s.uuid, { label: s.label, editedAt }]),
      ),
    },
    machines,
  };
}

const f0 = (): ConsoleFixture =>
  fixture("0", "Fresh Hub, no Account", [], [machine("studio", true, 0, null)]);

const f1 = (): ConsoleFixture =>
  fixture(
    "1",
    "1 Account, 1 Membership (today)",
    [
      {
        uuid: ACCOUNT.me,
        label: null,
        connection: "connected",
        setMinutesAgo: 60 * 24 * 3,
        seats: [{ organization: "Home Lab", fiveHour: 34, weekly: 61 }],
      },
    ],
    [
      machine("studio", true, 0, { account: ACCOUNT.me, organization: "Home Lab" }),
      machine("laptop", true, 0, { account: ACCOUNT.me, organization: "Home Lab" }),
    ],
  );

const f1m = (): ConsoleFixture =>
  fixture(
    "1m",
    "1 Account, 3 Memberships",
    [
      {
        uuid: ACCOUNT.me,
        label: "Solo",
        connection: "connected",
        setMinutesAgo: 60 * 24 * 3,
        source: "laptop",
        seats: [
          { organization: "Acme Team", fiveHour: 72, weekly: 40 },
          { organization: "Home Lab", fiveHour: 18, weekly: 55 },
          { organization: "Globex", fiveHour: null, weekly: null, limits: "forbidden" },
        ],
      },
    ],
    [
      machine("studio", true, 0, { account: ACCOUNT.me, organization: "Home Lab" }),
      machine("work-laptop", true, 2, { account: ACCOUNT.me, organization: "Acme Team" }),
    ],
  );

const f3c = (): ConsoleFixture =>
  fixture(
    "3c",
    "2 Accounts, 3 Memberships, one key expired",
    [
      {
        uuid: ACCOUNT.work,
        label: "Work",
        connection: "connected",
        setMinutesAgo: 60 * 30,
        source: "work-laptop",
        seats: [
          { organization: "Acme Team", fiveHour: 91, weekly: 48 },
          { organization: "Globex", fiveHour: null, weekly: null, limits: "forbidden" },
        ],
      },
      {
        uuid: ACCOUNT.personal,
        label: "Personal",
        connection: "expired",
        setMinutesAgo: 60 * 24 * 40,
        seats: [{ organization: "Home Lab", fiveHour: 22, weekly: 64 }],
      },
    ],
    [
      machine("studio", true, 0, { account: ACCOUNT.personal, organization: "Home Lab" }),
      machine("work-laptop", true, 1, { account: ACCOUNT.work, organization: "Acme Team" }),
      machine("build-box", false, 60 * 5, { account: ACCOUNT.work, organization: "Acme Team" }),
    ],
  );

const f14c = (): ConsoleFixture =>
  fixture(
    "14c",
    "5 Accounts, 13 Memberships",
    [
      {
        uuid: ACCOUNT.work,
        label: "Work",
        connection: "connected",
        setMinutesAgo: 60 * 30,
        source: "work-laptop",
        seats: [
          { organization: "Acme Team", fiveHour: 91, weekly: 48 },
          { organization: "Globex", fiveHour: null, weekly: null, limits: "forbidden" },
          { organization: "Initech", fiveHour: 12, weekly: 20 },
        ],
      },
      {
        uuid: ACCOUNT.personal,
        label: "Personal",
        connection: "connected",
        setMinutesAgo: 60 * 24 * 2,
        seats: [
          { organization: "Home Lab", fiveHour: 64, weekly: 71 },
          { organization: "Acme Team", fiveHour: 38, weekly: 52 },
        ],
      },
      {
        uuid: ACCOUNT.ci,
        label: "CI bot",
        connection: "expired",
        setMinutesAgo: 60 * 24 * 45,
        source: "build-box",
        seats: [
          { organization: "Acme CI", fiveHour: 55, weekly: 80 },
          { organization: "Umbrella", fiveHour: 9, weekly: 33 },
        ],
      },
      {
        uuid: ACCOUNT.consulting,
        label: "Consulting",
        connection: "connected",
        setMinutesAgo: 60 * 24 * 9,
        seats: [
          { organization: "Hooli", fiveHour: 77, weekly: 25 },
          { organization: "Pied Piper", fiveHour: 5, weekly: 12 },
          { organization: "Stark Ind.", fiveHour: null, weekly: 60 },
          { organization: "Wayne Ent.", fiveHour: 0, weekly: 4 },
          { organization: "Tyrell", fiveHour: null, weekly: null, limits: "forbidden" },
        ],
      },
      {
        uuid: ACCOUNT.side,
        label: null,
        connection: "disconnected",
        setMinutesAgo: null,
        seats: [{ organization: "unnamed", fiveHour: null, weekly: null }],
      },
    ],
    [
      machine("studio", true, 0, { account: ACCOUNT.personal, organization: "Home Lab" }),
      machine("work-laptop", true, 1, { account: ACCOUNT.work, organization: "Acme Team" }),
      machine("build-box", false, 60 * 5, { account: ACCOUNT.ci, organization: "Acme CI" }),
      machine("consult-mbp", true, 3, { account: ACCOUNT.consulting, organization: "Hooli" }),
      machine("side-vps", false, 60 * 24 * 3, null),
    ],
  );

export const CONSOLE_FIXTURES: Readonly<Record<string, () => ConsoleFixture>> = {
  "0": f0,
  "1": f1,
  "1m": f1m,
  "3c": f3c,
  "14c": f14c,
};
