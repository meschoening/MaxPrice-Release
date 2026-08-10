import { useEffect, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { ControlRow, Row } from "@/components/Rows";
import { logHubEvent } from "@/lib/hub-log";
import { updateCardView, type UpdateCardState } from "@/lib/update-card";
import { applyUpdate, detectUpdate, updatesSupported } from "@/lib/updater";
import { useNowTick } from "@/state/use-now-tick";

// App info — the console's sixth card (map #143). A plain `panel card` peer of
// the other five, not a recessive treatment and not a footer strip: the console's
// whole grammar is a vertical stack of equal-weight cards, and a button that
// restarts the hub does not belong in furniture.
//
// The card-head's status slot is deliberately EMPTY. Every other card fills it
// with that card's health; a version behind is not a fault, so filling it would
// both duplicate the Updates row and rank "there's a newer build" alongside "the
// daemon is unreachable".
//
// Eyebrow "App info" rather than "Updates": the row below is already called
// Updates, and the client's own Settings section holding the version is
// literally App info (map #100 T3) — one design system, one name for where a
// version lives.
//
// Every string is in `lib/update-card.ts`; this file is structure and wiring
// only. All copy decisions live there with their reasoning.
export function UpdatesCard(): React.ReactElement {
  const now = useNowTick();
  // The platform gate is STATIC and resolved once, at mount — never inferred
  // from `check()` returning null, which means "up to date" AND "no entry for
  // your platform" indistinguishably (map #143). Windows-only by SCOPE, not by
  // bug: ADR-0050 scopes the packaged tray app to Windows.
  const [state, setState] = useState<UpdateCardState>(() =>
    updatesSupported() ? { kind: "idle" } : { kind: "unsupported" },
  );

  // The probed handle, held across the two steps. Re-probing to install would
  // double the round-trips and could answer differently in between, so step 2
  // installs exactly the update step 1 showed. A ref, not state: it is never
  // rendered, and the plugin handle is not a value to diff on.
  const held = useRef<Update | null>(null);

  const runCheck = (manual: boolean): void => {
    setState({ kind: "checking" });
    detectUpdate()
      .then((probe) => {
        if (probe.status === "unsupported") {
          setState({ kind: "unsupported" });
          return;
        }
        if (probe.status === "up-to-date") {
          held.current = null;
          setState({ kind: "up-to-date", checkedAt: new Date().toISOString() });
          return;
        }
        held.current = probe.update;
        setState({ kind: "available", version: probe.version });
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        logHubEvent(`updates: ${manual ? "manual" : "launch"} check failed — ${detail}`);
        // A MANUAL failure is a state worth showing — a human asked and
        // deserves an answer. A LAUNCH failure is swallowed back to `idle`
        // (map #143 Q11): the hub autostarts at login, so the probe routinely
        // races the network coming up, and surfacing that as an error in a
        // console nobody opens for three days is a false alarm about a
        // condition that resolved in ninety seconds. The manual button is that
        // failure's remedy, and `idle` reads "we don't know" — which is true.
        setState(manual ? { kind: "error", detail } : { kind: "idle" });
      });
  };

  const runInstall = (): void => {
    const update = held.current;
    if (update === null) return;
    const version = update.version;
    setState({ kind: "installing", version });
    // On Windows this promise does not resolve: the plugin hands the installer
    // to ShellExecuteW and then calls `std::process::exit(0)` (#144). Only the
    // rejection path is reachable, and it is the one T2's table does not cover
    // — it returns to `available` with the button live and an `.err` line
    // inside the same inset, the console's established shape for a failed
    // action (HubStatusCard's firewall and compact insets do exactly this).
    applyUpdate(update).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      logHubEvent(`updates: install of ${version} failed — ${detail}`);
      setState({ kind: "available", version, installError: detail });
    });
  };

  // The launch probe. It reaches NOBODY by design — the console window is
  // `visible: false` at launch, though its webview mounts anyway — and that is
  // the point: it pre-populates the card so opening the console shows the answer
  // instantly instead of after a click. A LATENCY win, not a reach win. The real
  // answer to "nobody opens an always-on host's console" is a background probe
  // with a notification surface, which is its own effort (map #143, out of
  // scope).
  //
  // Exactly one webview probes. This card mounts only under <App/>, which
  // main.tsx renders for the `main` window alone (ADR-0050) — the always-alive
  // tray popout mounts <Popout/> and never sees this tree. The capability file
  // reinforces it: `updater:default` is granted to the `main` window only.
  //
  // The ref guard is for React StrictMode's deliberate double-invoke in dev; the
  // effect body is a network call, not an idempotent subscription.
  const probed = useRef(false);
  useEffect(() => {
    if (probed.current) return;
    probed.current = true;
    if (!updatesSupported()) return;
    runCheck(false);
    // Mount-only: the probe is a one-shot at launch, not a reaction to anything.
    // (No exhaustive-deps suppression needed — the react-hooks plugin is scoped
    // to apps/desktop in the flat config, so naming the rule here is an error.)
  }, []);

  const view = updateCardView(state, now);

  return (
    <section className="panel card" aria-label="App info">
      <div className="card-head">
        <span className="eyebrow">App info</span>
        <span className="status" />
      </div>
      <div className="krows">
        <Row label="Version" value={__APP_VERSION__} />
        <ControlRow label="Updates">
          <b title={view.valueTitle}>{view.value}</b>
          {view.sub !== undefined ? <span className="sub">{view.sub}</span> : null}
          {/* Step 1 — cheap and consequence-free, so it lives in the row. */}
          {view.action !== undefined ? (
            <button
              type="button"
              className="chip"
              disabled={view.action.disabled}
              onClick={() => {
                runCheck(true);
              }}
            >
              {view.action.label}
            </button>
          ) : null}
        </ControlRow>
      </div>
      {/* Step 2 — consequential, so it lives INSIDE the disclosure. The control
          relocates rather than mutating: the restart sentence cannot be skipped
          on the way to the button. Neutral tint, not warn — a newer build
          existing is not a fault, and spending the warn colour here would
          devalue the firewall row two cards up. (`chip active` is glass's name
          for the recipe the mock drew as `.chip.accent`.) */}
      {view.below?.kind === "inset" ? (
        <div className="inset" role="note">
          <p className="lead">{view.below.lead}</p>
          <p>{view.below.body}</p>
          <div className="btns">
            <button
              type="button"
              className="chip active"
              disabled={view.below.action.disabled}
              onClick={runInstall}
            >
              {view.below.action.label}
            </button>
          </div>
          {view.below.error !== undefined ? (
            <p className="err" title={view.below.error.title}>
              {view.below.error.message}
            </p>
          ) : null}
        </div>
      ) : null}
      {view.below?.kind === "err" ? <p className="err">{view.below.body}</p> : null}
      {view.below?.kind === "hint" ? (
        <p className="hint">
          {view.below.before}
          <code>{view.below.code}</code>
          {view.below.after}
        </p>
      ) : null}
    </section>
  );
}
