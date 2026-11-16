import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  matchAccountCard,
  type AccountCardView,
  type ProviderSectionView,
} from "@/lib/accounts-view";
import { settingsSectionId } from "@/lib/settings-sections";
import { cn } from "@/lib/utils";
import { AccountCard, type AccountCardActions } from "./account-card";
import { Pill } from "./atoms";

// One Provider's section of Settings › Accounts (#621): its header with
// "+ Add account" (the Connect flow opens under it), the filter past six
// Accounts, the tracked cards, and the "Not tracked · N" group, folded past
// two. The filter narrows both. `foot` closes the section (the Model-limit
// switch and the Remote Control hint, which Claude account carried). Pure:
// the page passes its fold map, the open flow and every action.

export function ProviderSection({
  section,
  open,
  onToggleOpen,
  flowFor,
  addFlow,
  notes,
  busyKey,
  onAdd,
  actions,
  foot,
  initialQuery = "",
  initialShowOff = false,
}: {
  section: ProviderSectionView;
  // Each card's fold, where the user changed it; else its view's default.
  open: Readonly<Record<string, boolean>>;
  onToggleOpen: (key: string, next: boolean) => void;
  // The Connect flow open in a card, else null.
  flowFor: (card: AccountCardView) => React.ReactNode;
  // The "+ Add account" flow, under the header; else null.
  addFlow: React.ReactNode;
  notes: Readonly<Record<string, string>>;
  // The card whose Disconnect is out.
  busyKey: string | null;
  onAdd: () => void;
  actions: AccountCardActions;
  foot?: React.ReactNode;
  initialQuery?: string;
  initialShowOff?: boolean;
}): React.ReactElement {
  const [query, setQuery] = useState(initialQuery);
  const [showOff, setShowOff] = useState(initialShowOff);
  // The card hosting the open Connect flow stays whatever the filter says: a
  // Pending account's own key folds it into an Account the query may not
  // match, and the result step must stay on screen (Sol #639 round 2).
  const shown = (cards: readonly AccountCardView[]) =>
    cards.filter((c) => matchAccountCard(c, query) || flowFor(c) !== null);
  const tracked = shown(section.cards);
  const off = shown(section.notTracked?.cards ?? []);
  const flowIn = (cards: readonly AccountCardView[]) => cards.some((c) => flowFor(c) !== null);
  // The group stays open while it is short, while a filter runs, or while a
  // flow is open in one of its rows.
  const offOpen =
    showOff ||
    query.trim() !== "" ||
    section.notTracked?.foldedByDefault !== true ||
    flowIn(section.notTracked?.cards ?? []);

  const card = (c: AccountCardView, compact: boolean) => {
    const flow = flowFor(c);
    return (
      <AccountCard
        key={c.key}
        card={c}
        compact={compact}
        expanded={flow !== null || (open[c.key] ?? c.fold.openByDefault)}
        onToggleOpen={() => onToggleOpen(c.key, !(open[c.key] ?? c.fold.openByDefault))}
        flow={flow}
        note={notes[c.key] ?? null}
        busy={busyKey === c.key}
        actions={actions}
      />
    );
  };

  return (
    <section
      className="s-section acct-section"
      id={settingsSectionId(section.name)}
      aria-label={section.name}
    >
      <div className="s-head">
        <h2>
          {section.showMark ? (
            <span className={cn("acct-mark", section.provider)} aria-hidden>
              {section.name[0]}
            </span>
          ) : null}
          {section.name}
        </h2>
        <button type="button" className="chip" onClick={onAdd} disabled={addFlow !== null}>
          {section.addAccount}
        </button>
      </div>
      <p className="desc">{section.description}</p>
      <div className="control acct-stack">
        {addFlow !== null ? <div className="acct-flow">{addFlow}</div> : null}
        {section.filterPlaceholder !== null ? (
          <input
            type="search"
            className="input acct-filter"
            placeholder={section.filterPlaceholder}
            aria-label={section.filterPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        ) : null}
        {tracked.map((c) => card(c, false))}
        {section.notTracked !== null && (off.length > 0 || query.trim() === "") ? (
          <div className="acct-off">
            <button
              type="button"
              className="acct-off-head"
              aria-expanded={offOpen}
              onClick={() => setShowOff(!offOpen)}
            >
              {offOpen ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
              <b>{section.notTracked.title}</b>
              {section.notTracked.hasNew ? <Pill tone="new">New</Pill> : null}
              <span className="acct-fact">{section.notTracked.hint}</span>
            </button>
            {offOpen ? off.map((c) => card(c, true)) : null}
          </div>
        ) : null}
        {query.trim() !== "" && tracked.length === 0 && off.length === 0 ? (
          <p className="hint-line">No Account matches “{query.trim()}”.</p>
        ) : null}
        {foot}
      </div>
    </section>
  );
}
