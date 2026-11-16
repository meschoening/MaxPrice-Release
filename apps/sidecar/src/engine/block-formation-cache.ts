import {
  compareHeadCandidates,
  headLead,
  formatMembershipToken,
  type HeadCandidate,
  scopeHasMembership,
  type BlocksResponse,
  type CostMode,
  type HomeMembership,
  type MembershipKey,
  type ResolvedScope,
  type UsageSample,
} from "@maxprice/shared";
import type { SampleScope } from "@maxprice/usage-core";
import {
  aggregateFormedBlocks,
  formPendingBlocks,
  resolveFormedBlockSpan,
  type AggregateBlocksOptions,
  type BlockFormation,
  type PendingBlock,
} from "./blocks";
import { FIVE_HOURS_MS, resolveWindows, type ResolvedWindow } from "./block-windows";
import { createBlockFlushCache } from "./block-flush-cache";
import { byTimestamp } from "./model-rollup";
import { eventAccount, eventOrganization, type Presumption } from "./presumption";
import { compileAxisMatcher, type EventStore, type StoreQuery, type StoredEvent } from "./store";

// Test-only work counter, like report-cache's foldCounter. Counts events sent
// through formation, not sample resolution or the separate totals fold.
export const formationCounter = { count: 0 };

function sameWindows(a: ResolvedWindow[], b: ResolvedWindow[]): boolean {
  return (
    a.length === b.length &&
    a.every((w, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        w.start === other.start &&
        w.end === other.end &&
        w.source === other.source
      );
    })
  );
}

// PRECONDITION (ADR-0091): unchanged resolved geometry, an epoch-monotone
// existing stream, and new events extending BOTH its string and epoch order.
// Only the last residual block and the resolved window containing the tail can
// gain events. These are separate frontiers: an observed block does NOT close
// the residual heuristic. In particular, the last displayed row is not a cut.
function extendFormation(state: BlockFormation, events: StoredEvent[]): void {
  const observed = new Map<number, PendingBlock>();
  const heuristic: PendingBlock[] = [];
  for (const block of state.formed) {
    if (block.source === "heuristic") heuristic.push(block);
    else observed.set(block.startMs, block);
  }
  let pending = heuristic[heuristic.length - 1];
  let wi = 0;
  for (const event of events) {
    const ms = event.ms;
    while (wi < state.windows.length && (state.windows[wi] as ResolvedWindow).end <= ms) wi++;
    const w = state.windows[wi];
    if (w !== undefined && w.start <= ms) {
      let block = observed.get(w.start);
      if (block === undefined) {
        block = { startMs: w.start, endMs: w.end, source: w.source, events: [] };
        observed.set(w.start, block);
      }
      block.events.push(event);
    } else {
      const last = pending?.events[pending.events.length - 1];
      if (
        pending === undefined ||
        last === undefined ||
        ms - pending.startMs > FIVE_HOURS_MS ||
        ms - last.ms > FIVE_HOURS_MS
      ) {
        const startMs = Math.floor(ms / 3_600_000) * 3_600_000;
        pending = { startMs, endMs: startMs + FIVE_HOURS_MS, source: "heuristic", events: [] };
        heuristic.push(pending);
      }
      pending.events.push(event);
    }
  }
  // Match the pure path's stable merge, including observed-before-heuristic
  // ties. A new hour-floored residual can sort BEFORE the last observed row.
  state.formed = [
    ...state.windows.flatMap((w) => {
      const block = observed.get(w.start);
      return block === undefined ? [] : [block];
    }),
    ...heuristic,
  ].sort((a, b) => a.startMs - b.startMs);
}

// What one formation forms its Blocks over: an Organization, the Home its
// unstamped samples presume under (the sample store's `SampleScope`), and which
// of the Organization's rows:
//   - `account` absent: every row of the Organization (the pre-#631 formation;
//     no Scope forms it since #635, but a caller may name it);
//   - an Account key: the rows the store's Account axis resolves to it inside
//     the Organization (ADR-0136 §2: a Block is one Membership's);
//   - `null`: the Organization's rows that resolve to no Account, the
//     Membership with an Account not known (ADR-0137 §3's notes, #635).
// `readings` picks the Organization's usage-limits samples this formation
// reads, by the Account each resolves to (ADR-0139 §8): those stamped with
// `account`, plus the unstamped ones when `unstamped` (they presume to this
// Membership, `sampleAccount`). Absent: every sample of the Organization. An
// Unknown Membership's `account` names the Organization's only known Account
// when it has exactly one, whose readings it borrows (#644).
// `{ account: null, unstamped: false }` reads none.
export type BlockReadings = { account: string | null; unstamped: boolean };
export type BlockScope = SampleScope & { account?: string | null; readings?: BlockReadings };

// The samples a formation reads (see `BlockScope.readings`).
export function samplesFor(
  samples: readonly UsageSample[],
  readings: BlockReadings | undefined,
): readonly UsageSample[] {
  if (readings === undefined) return samples;
  return samples.filter((s) =>
    s.accountUuid === undefined
      ? readings.unstamped
      : readings.account !== null && s.accountUuid === readings.account,
  );
}

// A request for a Scope's Blocks: the resolved Scope and the Home membership it
// resolved against. Null is no Home: the unscoped formation over every row and
// every sample, the path the golden corpus runs.
export type ScopeRequest = { scope: ResolvedScope; home: HomeMembership };

// The formation with no Home that names Accounts (#635, ADR-0136 §6's
// review-round note): the unscoped formation narrowed by the Scope's explicit
// Account keys, the same store Account axis the money reports read, so the
// span, its series and `/api/blocks` show those Accounts' rows and nothing
// else. It reads the readings stamped with one of them; an unstamped reading
// has no Account with no Home to presume it under.
//
// `memberships` (#637): a Scope named by Memberships with no Home narrows the
// same way, by the store's exact Membership axis, `accounts` then being its
// covering Account axis. Its readings are those stamped with one of its
// Memberships' Organization and Account.
export type AccountsFormation = {
  accounts: readonly string[];
  memberships?: readonly string[];
};

// Any one formation: a Membership's (`BlockScope`), the no-Home formation
// narrowed by Accounts, or `null`, the unscoped formation.
export type Formation = BlockScope | AccountsFormation | null;

const isAccounts = (spec: Formation): spec is AccountsFormation =>
  spec !== null && !("organization" in spec);

// The formation a Scope resolved with no Home forms: unscoped, unless its
// Account axis names keys (`resolveScope`'s no-Home rule), which narrow it.
export function noHomeFormation(scope: ResolvedScope): AccountsFormation | null {
  if (scope.memberships !== undefined) {
    return { accounts: scope.accounts, memberships: scope.memberships };
  }
  return scope.accounts.length === 0 ? null : { accounts: scope.accounts };
}

// The store axes an `AccountsFormation` selects its rows by.
function accountsAxes(spec: AccountsFormation): Pick<StoreQuery, "accounts" | "memberships"> {
  return {
    accounts: [...spec.accounts],
    ...(spec.memberships === undefined ? {} : { memberships: spec.memberships }),
  };
}

// The Account a sample with no Account stamp resolves to at query time
// (ADR-0139 §8): the only Account the Membership roster holds in its
// Organization, else this machine's Home membership's Account, else none. A
// sample is a usage-limits READING, never usage: it moves no cost or token
// into any Scope, and only picks which Membership's Blocks frame their windows
// with it. It is always this machine's own reading (or the Hub's backfill of
// the Organization it polled) of the limits of the key it polled with, so the
// keys this machine holds (the roster) and its own Home membership are the
// best word on whose limits it read, which they are not on whose usage a row
// is (`eventAccount`, #635). A sample stamped with an Account (#633) is that
// Account's, whatever this presumes (`samplesFor`).
export function sampleAccount(organizationUuid: string, p: Presumption): string | null {
  const holders = p.membershipRoster.get(organizationUuid);
  if (holders !== undefined && holders.size === 1) {
    for (const accountUuid of holders) return accountUuid;
  }
  return p.selfHome?.accountUuid ?? null;
}

type Slot = {
  spec: Formation;
  state: BlockFormation | null;
  additions: StoredEvent[];
  dirty: boolean;
  eventTimes: number[];
  last: StoredEvent | undefined;
  monotone: boolean;
  // The presumption the slot's rows were resolved under, and the predicate an
  // addition must pass to join them: the scoped query's own axes, compiled
  // against that presumption and the store's tracked Account set
  // (`compileAxisMatcher`), so the listener and the cold query agree on every
  // row (ADR-0107 §9).
  boundPresumption: Presumption | null;
  accepts: ((e: StoredEvent) => boolean) | null;
  flushCache: ReturnType<typeof createBlockFlushCache>;
};

// A formation's rows, narrowed further by `filters` (the `block` span's series
// takes the project, model and machine filters inside it). The one definition
// of which rows a `BlockScope` selects, so the span's series and the formation
// that framed it can never disagree.
export function formationRows(
  store: EventStore,
  spec: Formation,
  filters: Pick<StoreQuery, "projects" | "models" | "machines">,
): StoredEvent[] {
  if (spec === null) return store.query(filters);
  if (isAccounts(spec)) return store.query({ ...filters, ...accountsAxes(spec) });
  if (spec.account === null) {
    const p = store.presumption();
    return store
      .query({ ...filters, organizations: [spec.organization] })
      .filter((e) => eventAccount(e, p) === undefined);
  }
  return store.query({
    ...filters,
    organizations: [spec.organization],
    ...(spec.account === undefined ? {} : { accounts: [spec.account] }),
  });
}

function slotKey(spec: Formation): string {
  if (spec === null) return "*";
  if (isAccounts(spec)) {
    return JSON.stringify(["accounts", spec.accounts, spec.memberships ?? null]);
  }
  const account =
    spec.account === undefined ? "*" : spec.account === null ? "?" : `=${spec.account}`;
  const readings =
    spec.readings === undefined ? "*" : [spec.readings.account ?? "?", spec.readings.unstamped];
  return JSON.stringify([spec.organization, spec.home, account, readings]);
}

// The Block formation cache for BOTH block consumers, constructed inside
// buildApp over its live store accessor. Every formation reads one
// Membership's rows (the store's Organization and Account axes: evidence, then
// assertion, then presumption) and that Membership's samples alone, so windows,
// annulment and grace evidence never cross Memberships (ADR-0108 as amended by
// #632). No Home is the unscoped formation over every row and every sample.
//
// ONE SLOT PER FORMATION a request reads. A slot is keyed by its `BlockScope`,
// and a request for a Scope reads one per Membership in it; after each
// `blocks` or `scoped` call only the slots it read stay, beside the span's
// last, so a slot's `additions` never grow unqueried (ADR-0108 §6's reason for
// one slot, kept). A presumption change rebuilds every scoped slot; filter and
// pricing keys belong to each slot's flush cache; timed wire fields are always
// freshly assembled. No await inside a query or change listener: a response
// uses one coherent store + samples snapshot. Store swaps drop the old
// subscription and every slot.
export function createBlockReports(deps: {
  getStore: () => EventStore;
  // No scope: every sample held. A scope: that Organization's samples,
  // unstamped lines counting as `home`'s — the sample store's `all(scope)`.
  getSamples: (scope?: SampleScope) => readonly UsageSample[];
}) {
  let store: EventStore | null = null;
  let unsubscribe: (() => void) | null = null;
  const slots = new Map<string, Slot>();
  let spanKey: string | null = null;

  // The Memberships the stored rows resolve to, as (Organization, Account key
  // or undefined), each once, under the presumption it was read with. Grown by
  // additions, dropped by any replacement or deletion or a presumption change.
  type Present = { organization: string; account: string | undefined };
  let present: Map<string, Present> | null = null;
  let presentPresumption: Presumption | null = null;

  function newSlot(spec: Formation): Slot {
    return {
      spec,
      state: null,
      additions: [],
      dirty: true,
      eventTimes: [],
      last: undefined,
      monotone: true,
      boundPresumption: null,
      accepts: null,
      flushCache: createBlockFlushCache(),
    };
  }

  function bindStore(): EventStore {
    const current = deps.getStore();
    if (current === store) return current;
    unsubscribe?.();
    store = current;
    slots.clear();
    spanKey = null;
    present = null;
    unsubscribe = current.onChanged((changes) => {
      for (const { event, replaced } of changes) {
        // Whole-row replacement can change any field and inherit an earlier
        // map tie rank. Refuse it even when its new timestamp looks recent.
        // That holds whatever Membership either copy resolves to: a tag gain
        // is a replacement, and it can move a row out of a slot.
        if (replaced !== null || event === null) {
          for (const slot of slots.values()) {
            slot.dirty = true;
            slot.additions = [];
          }
          present = null;
          return;
        }
        // Pure formation drops NaN rows, so they cannot affect either order
        // or grace evidence. They remain stored for the other reports.
        if (Number.isNaN(event.ms)) continue;
        if (present !== null && presentPresumption !== null) notePresent(event, presentPresumption);
        for (const slot of slots.values()) {
          if (slot.dirty) continue;
          // Another Membership's row is not in the slot's stream, so it
          // neither extends nor dirties it. A presumption swap since binding
          // rebuilds at the next request anyway.
          if (slot.accepts !== null && !slot.accepts(event)) continue;
          slot.additions.push(event);
        }
      }
    });
    return current;
  }

  function notePresent(event: StoredEvent, p: Presumption): void {
    const organization = eventOrganization(event, p);
    if (organization === undefined || present === null) return;
    const account = eventAccount(event, p);
    const key = JSON.stringify([organization, account ?? null]);
    if (!present.has(key)) present.set(key, { organization, account });
  }

  function presentMemberships(current: EventStore, p: Presumption) {
    if (present === null || presentPresumption !== p) {
      present = new Map();
      presentPresumption = p;
      for (const event of current.query()) {
        if (!Number.isNaN(event.ms)) notePresent(event, p);
      }
    }
    return present.values();
  }

  // The slot's predicate for additions, as its cold query selects rows.
  function acceptor(
    spec: BlockScope | AccountsFormation,
    p: Presumption,
    tracked: ReadonlySet<string> | null,
  ): (e: StoredEvent) => boolean {
    if (isAccounts(spec)) {
      return compileAxisMatcher(accountsAxes(spec), p, tracked) ?? (() => true);
    }
    const matches =
      compileAxisMatcher(
        {
          organizations: [spec.organization],
          ...(typeof spec.account === "string" ? { accounts: [spec.account] } : {}),
        },
        p,
        tracked,
      ) ?? (() => true);
    if (spec.account !== null) return matches;
    return (e) => matches(e) && eventAccount(e, p) === undefined;
  }

  function formation(slot: Slot, samples: readonly UsageSample[]): BlockFormation {
    const current = bindStore();
    const spec = slot.spec;
    // The presumption is a formation input for a scoped slot: moving it means
    // other rows, so rebuild. It is compared by identity, which every writer
    // (Home, published Homes, assertions, the roster) mints anew. The unscoped
    // formation never reads it, so a swap leaves that slot alone.
    const presumption = current.presumption();
    if (spec !== null && presumption !== slot.boundPresumption) {
      slot.state = null;
      slot.additions = [];
      slot.dirty = true;
      slot.accepts = acceptor(spec, presumption, current.trackedAccounts());
    }
    slot.boundPresumption = presumption;

    const tail = byTimestamp(slot.additions);
    let prev = slot.last;
    if (tail.length > 0 && !slot.monotone) slot.dirty = true;
    for (const event of tail) {
      if (prev !== undefined && (event.timestamp < prev.timestamp || event.ms < prev.ms))
        slot.dirty = true;
      prev = event;
    }

    const state = slot.state;
    if (!slot.dirty && state !== null) {
      for (const event of tail) slot.eventTimes.push(event.ms);
      // Compare VALUES after full resolution, including grace evidence from
      // the new events. Length, latest capture, and sample-array identity are
      // not evidence that old windows survived late backfill or annulment.
      const windows = resolveWindows(samples, slot.eventTimes);
      if (sameWindows(state.windows, windows)) {
        if (tail.length > 0) extendFormation(state, tail);
        formationCounter.count += tail.length;
        slot.last = prev;
        slot.additions = [];
        return state;
      }
    }

    // The pure path is also the fallback for offset-bearing streams whose
    // string order regresses in epoch time. Never normalize or re-sort by ms.
    const events = formationRows(current, spec, {});
    const formed = formPendingBlocks(events, samples);
    slot.state = formed;
    formationCounter.count += events.length;
    slot.eventTimes = [];
    slot.last = undefined;
    slot.monotone = true;
    for (const event of events) {
      if (Number.isNaN(event.ms)) continue;
      if (slot.last !== undefined && event.ms < slot.last.ms) slot.monotone = false;
      slot.eventTimes.push(event.ms);
      slot.last = event;
    }
    slot.dirty = false;
    slot.additions = [];
    return formed;
  }

  function slotFor(spec: Formation): Slot {
    bindStore();
    const key = slotKey(spec);
    let slot = slots.get(key);
    if (slot === undefined) {
      slot = newSlot(spec);
      slots.set(key, slot);
    }
    return slot;
  }

  // Keep only the slots a call read, and the span's.
  function retain(keys: ReadonlySet<string>): void {
    for (const key of slots.keys()) {
      if (!keys.has(key) && key !== spanKey) slots.delete(key);
    }
  }

  // `quota` absent or `null`: the unscoped formation. The sample store reads
  // the Organization half alone.
  function samplesOf(spec: Formation): readonly UsageSample[] {
    if (spec === null) return deps.getSamples();
    if (isAccounts(spec)) {
      const { memberships } = spec;
      return deps
        .getSamples()
        .filter((s) =>
          s.accountUuid === undefined
            ? false
            : memberships === undefined
              ? spec.accounts.includes(s.accountUuid)
              : s.organizationUuid !== undefined &&
                memberships.includes(formatMembershipToken(s.organizationUuid, s.accountUuid)),
        );
    }
    return samplesFor(
      deps.getSamples({ organization: spec.organization, home: spec.home }),
      spec.readings,
    );
  }

  function formBlocks(
    spec: Formation,
    mode: CostMode,
    options: Omit<AggregateBlocksOptions, "samples">,
  ): BlocksResponse {
    const now = options.now ?? Date.now();
    const samples = samplesOf(spec);
    const slot = slotFor(spec);
    const formed = formation(slot, samples);
    const context = slot.flushCache.prepare(
      mode,
      options.models ?? [],
      options.machines ?? [],
      // The formation's Organization keys the totals beside the sum-narrowing
      // axes, though it narrows no sum: it chose the rows the blocks formed
      // from. `AggregateBlocksOptions` deliberately has no such field — see
      // the axis note in `block-flush-cache.ts`.
      spec === null || isAccounts(spec) ? [] : [spec.organization],
      samples,
      spec === null ? null : slotKey(spec),
    );
    return aggregateFormedBlocks(formed, mode, { ...options, now, samples }, context);
  }

  // A Scope's Memberships, head first, each with the formation that forms its
  // Blocks. The Home membership heads whenever the Scope holds it, so
  // `scopeHead`'s Home-in-scope rule names the same Organization; with its
  // Account not known, the Home membership IS its Organization's Unknown
  // Membership. After it, a Membership with rows in the Scope comes before
  // one without, which only the Organization's readings or the Home
  // membership minted, so a surface that shows one Membership's Blocks never
  // shows an empty one beside the Membership holding the usage. Ties fall to
  // `compareMemberships`. A Membership is any (Organization, Account) the
  // Scope reaches that the stored rows resolve to, that the Organization's
  // usage-limits readings resolve to (`sampleAccount`), or the Home
  // membership. Each forms from its own rows alone: a known Account's from the
  // rows that resolve to it, and, wherever the Scope holds Unknown, the
  // Organization's Unknown Membership from the rows that resolve to no
  // Account, this machine's and every peer's alike. A row with no Account
  // never joins a known Membership (ADR-0137 §3's notes, ADR-0108's
  // 2026-11-09 notes, #635); it is in no Membership of a Scope that names
  // Accounts explicitly.
  function scopeFormations(
    request: ScopeRequest,
  ): Array<{ membership: MembershipKey; spec: BlockScope; rows: boolean }> {
    const current = bindStore();
    const p = current.presumption();
    const { scope, home } = request;
    const homeOrg = home.organizationUuid;
    // Organization -> the Account keys of its Memberships in the Scope, `null`
    // standing for the Unknown one.
    const byOrg = new Map<string, Set<string | null>>();
    const add = (organization: string, account: string | null | undefined) => {
      const key = account ?? undefined;
      if (!scopeHasMembership(scope, organization, key)) return;
      let accounts = byOrg.get(organization);
      if (accounts === undefined) byOrg.set(organization, (accounts = new Set()));
      accounts.add(key ?? null);
    };
    // Which (Organization, Account key) pairs the stored rows reach in the
    // Scope; "?" stands for rows that resolve to no Account.
    const withRows = new Set<string>();
    const rowKey = (organization: string, account: string | null | undefined) =>
      JSON.stringify([organization, account ?? "?"]);
    // Organization -> every tracked Account known to hold a Membership in it,
    // in or out of the Scope: its rows', its readings', the roster's and the
    // Home membership's. An Unknown Membership borrows the readings of the
    // only one. An Excluded account is no Account here, as it mints no
    // Membership below (ADR-0136 §3).
    const tracked = current.trackedAccounts();
    const known = new Map<string, Set<string>>();
    const know = (organization: string, account: string | null | undefined) => {
      if (account === null || account === undefined) return;
      if (tracked !== null && !tracked.has(account)) return;
      let accounts = known.get(organization);
      if (accounts === undefined) known.set(organization, (accounts = new Set()));
      accounts.add(account);
    };
    for (const [organization, holders] of p.membershipRoster) {
      for (const account of holders) know(organization, account);
    }
    for (const m of presentMemberships(current, p)) {
      if (scopeHasMembership(scope, m.organization, m.account)) {
        withRows.add(rowKey(m.organization, m.account));
      }
      add(m.organization, m.account);
      know(m.organization, m.account);
    }
    add(homeOrg, home.accountUuid);
    know(homeOrg, home.accountUuid);
    // The Memberships the readings reach: a stamped sample's own Account, an
    // unstamped one's presumed Account. The sample history keeps every
    // reading, an Excluded account's included, so an Account outside the
    // store's tracked set mints no Membership here (ADR-0136 §3), as its rows
    // never reach the store.
    for (const sample of deps.getSamples()) {
      const organization = sample.organizationUuid ?? homeOrg;
      const account = sample.accountUuid ?? sampleAccount(organization, p);
      if (account !== null && tracked !== null && !tracked.has(account)) continue;
      add(organization, account);
      know(organization, account);
    }

    const out: Array<{ membership: MembershipKey; spec: BlockScope; rows: boolean }> = [];
    for (const [organization, accounts] of byOrg) {
      // Its readings: those stamped with the Membership's Account, and the
      // unstamped ones where they presume to it (`sampleAccount`), the
      // Unknown Membership's only while they presume to no Account.
      const readings = sampleAccount(organization, p);
      // The Unknown Membership's rows are some Account's of this
      // Organization. With only one Account known to hold a Membership in
      // it, they can only be that Account's, so they frame their Blocks by
      // its readings, as an unstamped reading presumes to it (#644, the owner's
      // decision; ADR-0108's and ADR-0137 §3's 2026-11-12 notes). The rows
      // stay Unknown: only the windows are borrowed. With two or more known,
      // or none, it reads only readings that presume to no Account.
      const holders = known.get(organization);
      const only = holders?.size === 1 ? [...holders][0]! : null;
      for (const account of accounts) {
        const reads = account ?? only;
        out.push({
          membership: { organizationUuid: organization, accountUuid: account },
          spec: {
            organization,
            home: homeOrg,
            account,
            // The Unknown Membership keeps the unstamped readings that
            // presume to no Account, borrowing or not.
            readings: {
              account: reads,
              unstamped: readings === reads || (account === null && readings === null),
            },
          },
          rows: withRows.has(rowKey(organization, account)),
        });
      }
    }
    // The shared head rule's order (`compareHeadCandidates`), so the first
    // is the Membership `scopeHeadOrganization` names; the lead is the Home
    // membership, or its Organization's Unknown one while only that holds
    // rows (`headLead`, #644).
    const lead = headLead(out, home);
    return out.sort((a, b) => compareHeadCandidates(a, b, home, lead));
  }

  // One formation's Blocks: `quota` names it (`BlockScope`), absent or `null`
  // is the unscoped formation.
  function blocks(
    mode: CostMode,
    options: Omit<AggregateBlocksOptions, "samples"> = {},
    quota: Formation = null,
  ): BlocksResponse {
    const body = formBlocks(quota, mode, options);
    retain(new Set([slotKey(quota)]));
    return body;
  }

  return {
    blocks,
    span(now: number, quota: Formation = null) {
      const slot = slotFor(quota);
      spanKey = slotKey(quota);
      return resolveFormedBlockSpan(formation(slot, samplesOf(quota)), now);
    },
    // The formation of the Scope's head Membership, the one a surface that
    // shows one Membership's Blocks reads (the span, the Active block tile).
    // Null with no Membership in the Scope.
    head(request: ScopeRequest): BlockScope | null {
      return scopeFormations(request)[0]?.spec ?? null;
    },
    // The Scope's candidate Memberships for the shared head rule
    // (`scopeHeadOrganization`), head first, each with whether the store
    // holds rows for it in the Scope.
    candidates(request: ScopeRequest): HeadCandidate[] {
      return scopeFormations(request).map(({ membership, rows }) => ({ membership, rows }));
    },
    // A Scope's Blocks (`BlocksResponse`): the head Membership's as `blocks`,
    // and, while the Scope spans two or more, every Membership's as
    // `memberships`, each formed on its own. Null is the unscoped formation.
    scoped(
      mode: CostMode,
      options: Omit<AggregateBlocksOptions, "samples"> = {},
      request: ScopeRequest | null,
    ): BlocksResponse {
      if (request === null) return blocks(mode, options, null);
      const formations = scopeFormations(request);
      const keys = new Set(formations.map((f) => slotKey(f.spec)));
      const memberships = formations.map((f) => ({
        organizationUuid: f.membership.organizationUuid,
        accountUuid: f.membership.accountUuid,
        blocks: formBlocks(f.spec, mode, options).blocks,
      }));
      retain(keys);
      const first = memberships[0];
      if (first === undefined) return { blocks: [] };
      return memberships.length === 1
        ? { blocks: first.blocks }
        : { blocks: first.blocks, memberships };
    },
  };
}
