import { useState } from "react";
import { Link } from "react-router-dom";
import { settingsConnectPath } from "@/lib/connect-flow";
import { usageTone } from "@maxprice/shared";
import {
  lastReadText,
  mostUsedReset,
  restPill,
  type LimitArea,
  type LimitCard,
  type LimitRest,
  type LimitWindowView,
} from "@/lib/limit-area";
import { cn } from "@/lib/utils";
import { OrganizationLabelParts } from "./membership-name";

// Live's limit area (#613 §5, #610, #637 D7, ADR-0142 §2): one Membership
// gets one card under a `Limits ·` eyebrow, two to four a card each, most
// used first, and five or more one board, a row per Membership, the four most
// used until Show all. Every number is one Membership's own window, never a
// sum. The rules are `lib/limit-area.ts`.

// The limit area between the Today and This week tiles.
export function LimitAreaView({
  area,
  nowMs,
  initiallyAll = false,
}: {
  area: LimitArea;
  nowMs: number;
  initiallyAll?: boolean;
}): React.ReactElement {
  if (area.kind === "single") {
    if (area.card === undefined) return <LimitsLoadingCard />;
    if (area.card === null) return <NoLimitsCard />;
    return <LimitCardView card={area.card} nowMs={nowMs} single />;
  }
  if (area.kind === "board")
    return <LimitBoard area={area} nowMs={nowMs} initiallyAll={initiallyAll} />;
  return (
    <section className="limit-area" aria-label="Usage limits" data-count={area.cards.length}>
      <div className="limit-cards" data-cols={area.cards.length}>
        {area.cards.map((card) => (
          <LimitCardView key={card.key} card={card} nowMs={nowMs} />
        ))}
      </div>
    </section>
  );
}

// Five or more: one board, a row per Membership (#610's resolution).
function LimitBoard({
  area,
  nowMs,
  initiallyAll,
}: {
  area: Extract<LimitArea, { kind: "board" }>;
  nowMs: number;
  initiallyAll: boolean;
}): React.ReactElement {
  const [all, setAll] = useState(initiallyAll);
  const shown = all ? area.cards : area.cards.slice(0, area.top);
  return (
    <section
      className="tile panel limit-area limit-board"
      aria-label="Usage limits"
      data-count={area.cards.length}
    >
      <div className="limit-board-head">
        <span className="eyebrow">Limits · {area.cards.length} Memberships</span>
        <span className="limit-board-sub">most used first · each its own, never summed</span>
      </div>
      <table className="limit-table">
        <tbody>
          {shown.map((card) => (
            <LimitBoardRow key={card.key} card={card} nowMs={nowMs} />
          ))}
        </tbody>
      </table>
      <div className="limit-board-foot">
        {!all ? <LimitRestPills rest={area.rest} /> : null}
        <button type="button" className="view-all" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : "Show all"}
        </button>
      </div>
    </section>
  );
}

function LimitRestPills({ rest }: { rest: LimitRest }): React.ReactElement {
  const pill = restPill(rest);
  return (
    <>
      <span className={cn("limit-note num", pill.tone)}>{pill.text}</span>
      {rest.unreadable > 0 ? (
        <span className="limit-note mute num">{rest.unreadable} not readable</span>
      ) : null}
    </>
  );
}

const BOARD_WINDOWS = [
  ["fiveHour", "5h", "no 5-hour limit"],
  ["weekly", "week", "no weekly limit"],
] as const;

function LimitBoardRow({ card, nowMs }: { card: LimitCard; nowMs: number }): React.ReactElement {
  const stale = card.state === "stale";
  const numbers = card.state === "readable" || stale;
  return (
    <tr className={cn("limit-board-row", card.tone === "bad" && "hot")} data-state={card.state}>
      <td className="limit-name-cell">
        <span className="limit-board-name">
          <b className="mname" title={card.organizationLabel}>
            <OrganizationLabelParts label={card.organizationLabel} />
          </b>
          {card.accountLabel !== null ? (
            <span className="limit-board-account" title={card.accountLabel}>
              · {card.accountLabel}
            </span>
          ) : null}
          {card.home ? (
            <span className="limit-home" title="Home membership" aria-label="Home membership">
              ⌂
            </span>
          ) : null}
        </span>
      </td>
      {numbers ? (
        <>
          {BOARD_WINDOWS.map(([kind, short, none]) => {
            const w = card.windows.find((x) => x.kind === kind);
            return (
              <td key={kind} className="limit-window-cell">
                {w === undefined ? (
                  <span className="limit-na">{none}</span>
                ) : (
                  <LimitWindowRow window={w} stale={stale} short={short} />
                )}
              </td>
            );
          })}
          <td className="limit-reset-cell num">
            {stale ? (
              <LimitRowNote card={card} />
            ) : (
              (mostUsedReset(card, nowMs) ?? "no window open")
            )}
          </td>
        </>
      ) : (
        <td colSpan={3} className="limit-span-cell">
          <LimitRowNote card={card} />
        </td>
      )}
    </tr>
  );
}

// A board row's state note, with the link that mends it.
function LimitRowNote({ card }: { card: LimitCard }): React.ReactElement | null {
  switch (card.state) {
    case "readable":
      return null;
    case "no-limits":
      return <span className="limit-note mute">no usage limits reported</span>;
    case "stale":
      return (
        <span className="limit-row-note">
          <span className="limit-note warn">key expired · last known</span>
          <Link to={settingsConnectPath(card.accountKey)} className="limit-reconnect">
            Reconnect
          </Link>
        </span>
      );
    case "not-connected":
      return (
        <span className="limit-row-note">
          <span className="limit-note mute">not connected</span>
          <Link to={settingsConnectPath(card.accountKey)} className="limit-reconnect">
            Settings
          </Link>
        </span>
      );
    case "unreadable":
      return <span className="limit-note mute">not readable now</span>;
  }
}

const STATE_NOTE: Partial<Record<LimitCard["state"], string>> = {
  "not-connected": "not connected",
  unreadable: "not readable now",
  stale: "key expired · last known",
};

// The one card's place while settings and the roster load: its eyebrow
// alone, so no "nothing to read" flashes before they answer.
function LimitsLoadingCard(): React.ReactElement {
  return (
    <div className="tile panel limit-card" data-state="loading">
      <span className="eyebrow">Limits</span>
    </div>
  );
}

// One Membership with nothing to read: no head, or none the roster lists yet.
function NoLimitsCard(): React.ReactElement {
  return (
    <div className="tile panel limit-card" data-state="none">
      <span className="eyebrow">Limits</span>
      <div className="inset dashed my-auto">
        <p>
          No limits read — connect an Account in <Link to="/settings">Settings</Link>.
        </p>
      </div>
    </div>
  );
}

export function LimitCardView({
  card,
  nowMs,
  single = false,
}: {
  card: LimitCard;
  nowMs: number;
  // The Scope's one card: it wears the `Limits ·` eyebrow, since no board or
  // sibling says what it is.
  single?: boolean;
}): React.ReactElement {
  const stale = card.state === "stale";
  const note = STATE_NOTE[card.state];
  const sub = [card.accountLabel, card.plan].filter((x) => x !== null).join(" · ");
  return (
    <div
      className={cn("tile panel limit-card", card.tone && `hot-${card.tone}`)}
      data-state={card.state}
    >
      <div className="limit-card-head">
        <span className="limit-card-name">
          <span className="limit-card-title">
            {single ? <span className="eyebrow limit-card-eyebrow">Limits · </span> : null}
            <b className="mname" title={card.organizationLabel}>
              <OrganizationLabelParts label={card.organizationLabel} />
            </b>
            {card.home ? (
              <span className="limit-home" title="Home membership" aria-label="Home membership">
                ⌂
              </span>
            ) : null}
          </span>
          {sub !== "" ? (
            <span className="tile-sub limit-card-account" title={sub}>
              {sub}
            </span>
          ) : null}
          {note !== undefined ? (
            <span className={cn("limit-note", stale ? "warn" : "mute")}>{note}</span>
          ) : null}
        </span>
        {card.ringPct !== null ? (
          <LimitRing pct={card.ringPct} tone={card.tone} stale={stale} />
        ) : null}
      </div>
      {card.windows.map((w) => (
        <LimitWindowRow key={w.kind} window={w} stale={stale} />
      ))}
      {card.noFiveHour ? (
        <span className="limit-note mute limit-card-none">no 5-hour limit on this plan</span>
      ) : null}
      <LimitCardFoot card={card} nowMs={nowMs} />
    </div>
  );
}

function LimitWindowRow({
  window: w,
  stale,
  short,
}: {
  window: LimitWindowView;
  stale: boolean;
  // The board's short label ("5h", "week"); a card spells the window out.
  short?: string;
}): React.ReactElement {
  const pct = w.pct === null ? null : Math.round(w.pct);
  return (
    <div
      className={cn(
        "limit-row",
        short === undefined ? "limit-card-row" : "limit-board-window",
        w.pct === null && "idle",
      )}
    >
      <label title={`${w.label} limit used`}>{short ?? w.label}</label>
      <span
        className="limit-meter"
        role="meter"
        aria-valuenow={pct ?? 0}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${w.label} limit used`}
        aria-valuetext={pct === null ? "no window open" : `${pct}%`}
      >
        {pct === null ? null : (
          <i
            data-tone={stale ? "stale" : (usageTone(pct) ?? undefined)}
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        )}
      </span>
      <b className="num">{pct === null ? "—" : `${pct}%`}</b>
    </div>
  );
}

function LimitCardFoot({ card, nowMs }: { card: LimitCard; nowMs: number }): React.ReactElement {
  switch (card.state) {
    case "readable":
      return <span className="limit-card-foot num">{card.resets ?? "No limit window open"}</span>;
    case "no-limits":
      return <span className="limit-card-foot">No usage limits reported.</span>;
    case "stale": {
      const read = lastReadText(card.lastReadAtMs, nowMs);
      return (
        <span className="limit-card-foot warn num">
          Key expired{read !== null ? ` · ${read}` : ""} ·{" "}
          <Link to={settingsConnectPath(card.accountKey)} className="limit-reconnect">
            Reconnect
          </Link>
        </span>
      );
    }
    case "not-connected":
      return (
        <span className="limit-card-foot">
          Connect this Account to read its limits.{" "}
          <Link to={settingsConnectPath(card.accountKey)} className="limit-reconnect">
            Settings
          </Link>
        </span>
      );
    case "unreadable":
      return <span className="limit-card-foot">Its limits can’t be read right now.</span>;
  }
}

// The card's ring: the most used window's percent (44px, r=17).
const R = 17;
const C = 2 * Math.PI * R;
export function LimitRing({
  pct,
  tone,
  stale,
}: {
  pct: number;
  tone: "bad" | "warn" | null;
  stale: boolean;
}): React.ReactElement {
  const frac = Math.max(0, Math.min(1, pct / 100));
  const rounded = Math.round(pct);
  return (
    <svg
      className="limit-ring"
      viewBox="0 0 44 44"
      width="44"
      height="44"
      role="img"
      aria-label={`Most used limit: ${rounded}%`}
      data-tone={stale ? "stale" : (tone ?? undefined)}
    >
      <circle className="limit-ring-track" cx="22" cy="22" r={R} />
      {frac > 0 ? (
        <circle
          className="limit-ring-fill"
          cx="22"
          cy="22"
          r={R}
          strokeDasharray={`${(frac * C).toFixed(2)} ${C.toFixed(2)}`}
          transform="rotate(-90 22 22)"
        />
      ) : null}
      <text x="22" y="25.5" textAnchor="middle" className="limit-ring-label">
        {rounded}%
      </text>
    </svg>
  );
}
