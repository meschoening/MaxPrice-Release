import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  accountCardId,
  STALE_RECONNECT,
  UNASSIGN,
  type AccountCardView,
  type MembershipRowView,
} from "@/lib/accounts-view";
import { cn } from "@/lib/utils";
import { AccountAvatar, ConnectionState, HomeBadge, LabelField, Pill, TrackSwitch } from "./atoms";

// One Account's card in Settings › Accounts (#621 variant A; ADR-0136 §3–§7,
// ADR-0138 §3–§8, ADR-0141 §8): its head (avatar, title over its sub line,
// connection state, Connect or Reconnect, the Account's Track switch), its
// tool line (Rename or Label, Disconnect, "key set ‹date›", the local key's
// fact), its "Seen through" line, and its Memberships, each with the
// Organization's own Track switch and, while sessions are assigned to it,
// "N sessions assigned · Unassign" (#672). Past six Accounts it folds to one line
// behind a chevron. A Not tracked row is compact: its head and Label, no
// Memberships. The Connect flow opens inside it, in place of its Memberships.
// Pure: the view and every action come in, so static rendering tests it.

export interface AccountCardActions {
  // Open this card's Connect (its Connect, Reconnect, or a stale reading's
  // Reconnect).
  onConnect: (card: AccountCardView) => void;
  onToggleAccount: (card: AccountCardView) => void;
  onToggleOrganization: (card: AccountCardView, membership: MembershipRowView) => void;
  // Resolve null once saved, else the refusal to show under the input.
  onLabel: (card: AccountCardView, label: string | null) => Promise<string | null>;
  onRenameOrganization: (uuid: string, label: string | null) => Promise<string | null>;
  onDisconnect: (card: AccountCardView) => void;
  // Clear every session's assignment to this row's Organization (#672), and
  // whether that write is out for an Organization.
  onUnassign: (membership: MembershipRowView) => void;
  unassigning: (organizationUuid: string) => boolean;
}

export function AccountCard({
  card,
  expanded,
  compact = false,
  onToggleOpen,
  flow,
  note,
  busy = false,
  actions,
  initialEditing,
}: {
  card: AccountCardView;
  // Unfolded: its tool line and Memberships show.
  expanded: boolean;
  compact?: boolean;
  onToggleOpen: () => void;
  // The Connect flow open in this card, else null.
  flow: React.ReactNode;
  // The note after a Disconnect while the Hub holds a key.
  note: string | null;
  // A Disconnect is out.
  busy?: boolean;
  actions: AccountCardActions;
  // Seeds the editor for static rendering: "label" or an Organization uuid.
  initialEditing?: string;
}): React.ReactElement {
  const [editing, setEditing] = useState<string | null>(initialEditing ?? null);
  const folded = card.fold.foldable && !expanded;
  const open = compact || !folded;
  const flowOpen = flow !== null && flow !== undefined && flow !== false;

  return (
    <div
      id={accountCardId(card.key)}
      className={cn("acct-card", compact && "compact", folded && "folded", !card.track.on && "off")}
      role="group"
      aria-label={card.title}
    >
      <div className="acct-head">
        {card.fold.foldable && !compact ? (
          <button
            type="button"
            className="acct-fold"
            aria-expanded={expanded}
            aria-label={expanded ? `Fold ${card.title}` : `Unfold ${card.title}`}
            onClick={onToggleOpen}
          >
            {expanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
          </button>
        ) : null}
        <AccountAvatar avatar={card.avatar} compact={compact} />
        <span className="acct-who">
          {editing === "label" ? (
            <LabelField
              current={card.userLabel}
              placeholder={card.userLabel === null ? card.title : (card.email ?? card.title)}
              ariaLabel="Account label"
              onSave={(label) => actions.onLabel(card, label)}
              onDone={() => setEditing(null)}
            />
          ) : folded ? (
            <span className="acct-line">{card.fold.line}</span>
          ) : (
            <>
              <b className="acct-title">{card.title}</b>
              {card.sub !== null ? <span className="acct-sub">{card.sub}</span> : null}
            </>
          )}
        </span>
        <span className="acct-right">
          {card.connection !== null ? (
            <ConnectionState text={card.connection.text} tone={card.connection.tone} />
          ) : null}
          {card.action !== null && !flowOpen ? (
            <button
              type="button"
              className={cn("chip", card.action === "Reconnect" && "warn")}
              onClick={() => actions.onConnect(card)}
            >
              {card.action}
            </button>
          ) : null}
          <TrackSwitch
            on={card.track.on}
            canToggle={card.track.canToggle}
            title={card.track.title}
            label={`Track ${card.title}`}
            onToggle={() => actions.onToggleAccount(card)}
          />
        </span>
      </div>

      {open ? (
        <CardTools
          card={card}
          compact={compact}
          busy={busy}
          onLabel={() => setEditing("label")}
          onDisconnect={() => actions.onDisconnect(card)}
        />
      ) : null}
      {open && !compact && card.seenThrough !== null ? (
        <p className="acct-seen">{card.seenThrough}</p>
      ) : null}
      {note !== null ? (
        <p className="acct-note" role="status">
          {note}
        </p>
      ) : null}
      {flowOpen ? <div className="acct-flow">{flow}</div> : null}
      {open && !compact && !flowOpen && card.memberships.length > 0 ? (
        <ul className="acct-mems" aria-label={`${card.title}'s Organizations`}>
          {card.memberships.map((m) => (
            <MembershipRow
              key={m.organizationUuid}
              card={card}
              m={m}
              editing={editing === m.organizationUuid}
              onEdit={() => setEditing(m.organizationUuid)}
              onEditDone={() =>
                setEditing((current) => (current === m.organizationUuid ? null : current))
              }
              actions={actions}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CardTools({
  card,
  compact,
  busy,
  onLabel,
  onDisconnect,
}: {
  card: AccountCardView;
  compact: boolean;
  busy: boolean;
  onLabel: () => void;
  onDisconnect: () => void;
}): React.ReactElement | null {
  const { tools } = card;
  const facts = compact ? [] : [tools.keySet, tools.localKey].filter((f) => f !== null);
  const disconnect = !compact && tools.disconnect !== null;
  if (tools.rename === null && !disconnect && facts.length === 0) return null;
  return (
    <div className="acct-tools">
      {tools.rename !== null ? (
        <button type="button" className="acct-link" onClick={onLabel}>
          {tools.rename}
        </button>
      ) : null}
      {disconnect ? (
        <button type="button" className="acct-link" disabled={busy} onClick={onDisconnect}>
          Disconnect
        </button>
      ) : null}
      {facts.map((fact) => (
        <span key={fact} className="acct-fact">
          {fact}
        </span>
      ))}
    </div>
  );
}

function MembershipRow({
  card,
  m,
  editing,
  onEdit,
  onEditDone,
  actions,
}: {
  card: AccountCardView;
  m: MembershipRowView;
  editing: boolean;
  onEdit: () => void;
  onEditDone: () => void;
  actions: AccountCardActions;
}): React.ReactElement {
  return (
    <li className={cn("acct-mem", !m.track.on && "off")}>
      <span className="acct-org">
        {editing ? (
          <LabelField
            current={m.renamed ? m.bareLabel : null}
            placeholder={m.defaultLabel}
            ariaLabel="Organization label"
            onSave={(label) => actions.onRenameOrganization(m.organizationUuid, label)}
            onDone={onEditDone}
          />
        ) : (
          <button type="button" className="acct-org-name" title="Rename" onClick={onEdit}>
            {m.label}
          </button>
        )}
        {m.plan !== null && m.plan !== m.label ? <span className="acct-fact">{m.plan}</span> : null}
        {m.isNew ? <Pill tone="new">New</Pill> : null}
        {m.also !== null ? (
          <span className="acct-fact" title="One Organization: its tracking is shared">
            {m.also}
          </span>
        ) : null}
        {m.assigned !== null ? (
          <span className="acct-fact acct-assigned">
            {m.assigned}
            {" · "}
            <button
              type="button"
              className="acct-link"
              title={UNASSIGN.title}
              disabled={actions.unassigning(m.organizationUuid)}
              onClick={() => actions.onUnassign(m)}
            >
              {UNASSIGN.label}
            </button>
          </span>
        ) : null}
      </span>
      <span className="acct-right">
        {m.read === null ? null : m.read.kind === "unreadable" ? (
          <Pill tone="warn" title={m.read.title ?? undefined}>
            {m.read.text}
          </Pill>
        ) : (
          <span className="acct-fact stale">
            {m.read.text}
            {m.read.reconnect ? (
              <>
                {" · "}
                <button type="button" className="acct-link" onClick={() => actions.onConnect(card)}>
                  {STALE_RECONNECT}
                </button>
              </>
            ) : null}
          </span>
        )}
        {m.home ? <HomeBadge /> : null}
        <TrackSwitch
          on={m.track.on}
          canToggle={m.track.canToggle}
          title={m.track.title}
          label={`Track ${m.label}`}
          onToggle={() => actions.onToggleOrganization(card, m)}
        />
      </span>
    </li>
  );
}
