import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  accountSourcesQueryKey,
  excludeAccountPatch,
  excludePatch,
  homeMembershipPatch,
  pendingHashOf,
  trackAccountPatch,
  trackPatch,
  usageKeysQueryKey,
  type UsageConnection,
} from "@maxprice/shared";
import {
  accountCardId,
  accountsView,
  GATEWAYS_SECTION,
  hubHostOf,
  organizationTrack,
  type AccountCardView,
  type AccountsView,
} from "@/lib/accounts-view";
import {
  connectHelper,
  connectLead,
  parseSettingsConnect,
  runConnect,
  SETTINGS_ACCOUNTS_ANCHOR,
  type ConnectTarget,
} from "@/lib/connect-flow";
import { runAssertionWrite, unassignWrite } from "@/lib/assignment-writes";
import { disconnectKey } from "@/lib/credential-ops";
import { checkGateway, removeGatewayCredential, setGatewayCredential } from "@/lib/gateway-config";
import { connectGateway } from "@/lib/gateway-connect";
import { readStoredHubPassword, pushHubConfigToSidecar } from "@/lib/hub-config";
import { applyHubAutoHeal } from "@/lib/hub-auto-heal";
import { settingsSectionId, SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { insideTauri } from "@/lib/tauri";
import { showToast } from "@/lib/toast";
import { trackingFacts } from "@/lib/tracking-confirm";
import {
  discoverOrgsViaSidecar,
  readAccountCredentials,
  tauriCredentialIo,
} from "@/lib/usage-credential";
import { useAccountSources } from "@/state/use-account-sources";
import {
  organizationAssertionsQueryKey,
  putOrganizationAssertions,
  useOrganizationAssertions,
} from "@/state/use-organization-assertions";
import { connectTargetKey, submitConnect, useConnectFlow } from "@/state/use-connect-flow";
import { gatewaysQueryKey, useGateways } from "@/state/use-gateways";
import { useLiveStatus } from "@/state/use-live-status";
import {
  accountsQueryKey,
  fetchAccounts,
  fetchOrganizations,
  organizationsQueryKey,
  renameOrganization,
  setAccountLabel,
  useAccounts,
  useOrganizations,
} from "@/state/use-organizations";
import { useSettings, useTimeDisplay, useUpdateSettings } from "@/state/use-settings";
import { useSettingsLastOpened } from "@/state/use-settings-last-opened";
import { useUsageKeys } from "@/state/use-usage-keys";
import { UnattributedUsage } from "../unattributed-usage";
import { Section } from "../settings-section";
import { ExcludeConfirm, TrackConfirm } from "../tracking-dialog";
import { type AccountCardActions } from "./account-card";
import { ClaudeSectionFoot } from "./claude-foot";
import { ConnectPasteContent, ConnectResultContent } from "./connect-panel";
import { GatewaysSection } from "./gateways";
import { ProviderSection } from "./provider-section";
import { AccountStrips, HomeMembershipSelects } from "./strips";

// Settings › Accounts (#621's resolution, #639; ADR-0136 §3–§7, ADR-0138
// §3–§8 and §12, ADR-0141 §7–§8): the first cluster on the Settings page. Top
// to bottom: the attention strips, the Home membership select (past one
// Account), one section per Provider with its Account cards, the Gateways
// subsection, and Unattributed usage. Every word and state comes from
// `accountsView` (lib/accounts-view.ts); this file reads the queries, binds
// the writes and holds what is open: each card's fold, the Connect flow (in
// `useConnectFlow`, so a card that regroups keeps it), the Gateway form, a
// pending confirmation and the notes a Disconnect or Remove leaves.
//
// Tracking an Organization confirms as it always has (Track, and Exclude by
// typing its label). Excluding an Account confirms the same typed way, since
// it repairs as excluding an Organization does (ADR-0136 §3): its usage
// leaves every report here and the Hub. Tracking an Account asks nothing: it
// only widens what counts, as Connect's own tracking does (ADR-0136 §4).
//
// Unassign on an Organization row (#672) clears every session's assignment to
// that Organization at once and toasts with Undo, as Assign does: it moves
// usage between Memberships and deletes nothing.
//
// `?connect=<account key>` (`settingsConnectPath`, #638's D3: Live's
// Reconnect) opens that Account's Connect, unfolds its card and scrolls to it.

type Confirm =
  | {
      kind: "organization";
      mode: "track" | "exclude";
      uuid: string;
      label: string;
      // The connection of the Account it was toggled under.
      connection: UsageConnection;
    }
  | { kind: "account"; key: string; bareLabel: string };

// Each held key's `setAt`, from the keychain (Tauri only), for "key set
// ‹date›". Read again whenever the held set changes, and after a Connect.
const KEY_SET_AT_KEY = "usage-key-set-at";
function useKeySetAt(signature: string): ReadonlyMap<string, string> | undefined {
  const query = useQuery({
    queryKey: [KEY_SET_AT_KEY, signature],
    queryFn: async () =>
      new Map((await readAccountCredentials()).map((k) => [k.accountUuid, k.entry.setAt])),
    enabled: insideTauri(),
  });
  return query.data;
}

export function AccountsCluster(): React.ReactElement {
  const { data: accounts } = useAccounts();
  const { data: keys } = useUsageKeys();
  const { data: roster } = useOrganizations();
  const { data: settings } = useSettings();
  const { data: sources } = useAccountSources();
  const { data: gateways } = useGateways();
  const assertions = useOrganizationAssertions();
  const update = useUpdateSettings();
  const display = useTimeDisplay();
  const lastOpenedAt = useSettingsLastOpened();
  const hubConnection = useLiveStatus((s) => s.hubConnection);
  const qc = useQueryClient();
  const flow = useConnectFlow();
  const keySetAt = useKeySetAt((keys?.keys ?? []).map((k) => k.accountUuid).join(","));

  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [sendKeysBusy, setSendKeysBusy] = useState(false);
  const [sendKeysError, setSendKeysError] = useState<string | null>(null);
  const [gatewayFormOpen, setGatewayFormOpen] = useState(false);
  const [gatewayNotes, setGatewayNotes] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<string | null>(null);
  const [unassigning, setUnassigning] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<string | null>(null);

  const hubUrl = settings?.hubUrl ?? "";
  const autoHeal = settings?.hubAutoHeal ?? true;
  const hub = useMemo(
    () => ({
      // Only a connected client's answers are certainly the Hub's.
      hubSourced: hubConnection === "connected",
      hubHost: hubHostOf(hubUrl),
      autoHeal,
    }),
    [hubConnection, hubUrl, autoHeal],
  );

  const view: AccountsView | null = useMemo(
    () =>
      accounts === undefined
        ? null
        : accountsView({
            accounts,
            keys,
            roster,
            settings: settings ?? null,
            sources,
            assertions,
            gateways,
            keySetAt,
            hub,
            lastOpenedAt,
            display,
            nowMs: Date.now(),
          }),
    [
      accounts,
      keys,
      roster,
      settings,
      sources,
      assertions,
      gateways,
      keySetAt,
      hub,
      lastOpenedAt,
      display,
    ],
  );
  const cards = useMemo(
    () => view?.providers.flatMap((p) => [...p.cards, ...(p.notTracked?.cards ?? [])]) ?? [],
    [view],
  );

  const openFlow = (target: ConnectTarget): void => {
    useConnectFlow.getState().open(target);
    if (target.kind === "account") setOpen((o) => ({ ...o, [target.accountKey]: true }));
  };

  // #638's D3: `?connect=` opens that Account's Connect once per navigation.
  const location = useLocation();
  const connectParam = parseSettingsConnect(location.search);
  const handled = useRef<string | null>(null);
  // Leaving Settings keeps no flow open. The deep link counts as unhandled
  // again, so a remount (React's StrictMode runs every effect twice in dev)
  // reopens the flow its cleanup closed.
  useEffect(
    () => () => {
      useConnectFlow.getState().close();
      handled.current = null;
    },
    [],
  );
  useEffect(() => {
    if (connectParam === null || view === null || handled.current === location.key) return;
    handled.current = location.key;
    if (!cards.some((c) => c.key === connectParam)) return;
    openFlow({ kind: "account", accountKey: connectParam });
    setScrollTo(connectParam);
  }, [connectParam, location.key, view, cards]);
  useEffect(() => {
    if (scrollTo === null) return;
    document.getElementById(accountCardId(scrollTo))?.scrollIntoView({ block: "center" });
    setScrollTo(null);
  }, [scrollTo]);

  const refreshKeys = (): void => {
    void qc.invalidateQueries({ queryKey: usageKeysQueryKey() });
    void qc.invalidateQueries({ queryKey: accountsQueryKey() });
    void qc.invalidateQueries({ queryKey: organizationsQueryKey() });
    void qc.invalidateQueries({ queryKey: accountSourcesQueryKey() });
    void qc.invalidateQueries({ queryKey: [KEY_SET_AT_KEY] });
  };

  const submit = (target: ConnectTarget, sessionKey: string): void => {
    void submitConnect(target, () =>
      runConnect(
        {
          discover: discoverOrgsViaSidecar,
          io: tauriCredentialIo,
          updateSettings: update,
          accounts: () => fetchAccounts(),
          organizations: () => fetchOrganizations(),
        },
        {
          target,
          sessionKey,
          keys,
          accounts: accounts?.accounts,
          hub,
          lastOpenedAt,
        },
      ),
    ).finally(refreshKeys);
  };

  const rosterBy = new Map((roster?.organizations ?? []).map((o) => [o.uuid, o]));
  const toggleOrganization = (
    uuid: string,
    label: string,
    on: boolean,
    connection: UsageConnection,
  ): void => {
    // An Organization the roster has not listed yet has no facts to confirm
    // with: tracking it writes at once.
    if (!on && !rosterBy.has(uuid)) {
      void update((current) => trackPatch(current, uuid));
      return;
    }
    setConfirm({ kind: "organization", mode: on ? "exclude" : "track", uuid, label, connection });
  };

  const flowNode = (target: ConnectTarget): React.ReactNode => {
    const current = flow.target;
    if (current === null || connectTargetKey(current) !== connectTargetKey(target)) return null;
    if (flow.result !== null) {
      return (
        <ConnectResultContent
          result={flow.result}
          organizations={flow.result.organizations.map((org) => ({
            ...org,
            track: organizationTrack(
              org.organizationUuid,
              rosterBy.get(org.organizationUuid),
              settings ?? null,
              true,
            ),
          }))}
          onToggle={(org) =>
            toggleOrganization(org.organizationUuid, org.label, org.track.on, "connected")
          }
          onDone={() => useConnectFlow.getState().close()}
        />
      );
    }
    return (
      <ConnectPasteContent
        key={connectTargetKey(target)}
        lead={connectLead(target, accounts?.accounts, keys)}
        helper={connectHelper(hub)}
        busy={flow.busy}
        error={flow.error}
        onSubmit={(sessionKey) => submit(target, sessionKey)}
        onCancel={() => useConnectFlow.getState().close()}
      />
    );
  };

  const actions: AccountCardActions = {
    onConnect: (card) => openFlow({ kind: "account", accountKey: card.key }),
    onToggleAccount: (card) => {
      if (card.track.on) {
        setConfirm({ kind: "account", key: card.key, bareLabel: card.title });
      } else {
        void update((current) => trackAccountPatch(current, card.key));
      }
    },
    onToggleOrganization: (card, m) =>
      toggleOrganization(
        m.organizationUuid,
        m.label,
        m.track.on,
        card.connection?.state ?? "disconnected",
      ),
    onLabel: async (card, label) => {
      if (card.accountUuid === null) return "A Pending account takes no label";
      try {
        qc.setQueryData(accountsQueryKey(), await setAccountLabel(card.accountUuid, label));
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    onRenameOrganization: async (uuid, label) => {
      try {
        qc.setQueryData(organizationsQueryKey(), await renameOrganization(uuid, label));
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    onDisconnect: (card) => {
      const target = card.tools.disconnect;
      if (target === null || busyKey !== null) return;
      setBusyKey(card.key);
      disconnectKey(target, tauriCredentialIo)
        .then(() => {
          // ADR-0138 §7: a client's Disconnect is local; the Hub keeps its key.
          const note = card.disconnectNote;
          if (note !== null) setNotes((n) => ({ ...n, [card.key]: note }));
          refreshKeys();
        })
        .catch((e: unknown) =>
          showToast(`Couldn't disconnect: ${e instanceof Error ? e.message : String(e)}`),
        )
        .finally(() => setBusyKey(null));
    },
    onUnassign: (m) => {
      const write = assertions === undefined ? null : unassignWrite(assertions, m.organizationUuid);
      if (write === null || unassigning !== null) return;
      setUnassigning(m.organizationUuid);
      void runAssertionWrite(write, {
        put: putOrganizationAssertions,
        invalidate: () => void qc.invalidateQueries({ queryKey: organizationAssertionsQueryKey() }),
        toast: showToast,
        setPending: (pending) => {
          if (!pending) setUnassigning(null);
        },
        clearSelection: () => {},
      });
    },
    unassigning: (uuid) => unassigning === uuid,
  };

  const sendKeys = (next: boolean): void => {
    setSendKeysBusy(true);
    setSendKeysError(null);
    applyHubAutoHeal(next, {
      hubUrl,
      update,
      readPassword: readStoredHubPassword,
      push: pushHubConfigToSidecar,
    })
      .catch((e: unknown) => setSendKeysError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSendKeysBusy(false));
  };

  const removeGateway = (id: string): void => {
    if (removing !== null) return;
    const row = view?.gateways.rows.find((r) => r.id === id);
    setRemoving(id);
    removeGatewayCredential(id)
      .then(() => {
        // ADR-0141 §7: a Gateway on the Hub is removed only at the Hub.
        if (hub.hubHost !== null && row?.drainedByHub != null) {
          const host = hub.hubHost;
          setGatewayNotes((n) => ({ ...n, [id]: GATEWAYS_SECTION.removedHere(row.host, host) }));
        }
        void qc.invalidateQueries({ queryKey: gatewaysQueryKey() });
        void qc.invalidateQueries({ queryKey: accountSourcesQueryKey() });
      })
      .catch((e: unknown) =>
        showToast(`Couldn't remove the Gateway: ${e instanceof Error ? e.message : String(e)}`),
      )
      .finally(() => setRemoving(null));
  };

  const openGatewayForm = (): void => {
    setGatewayFormOpen(true);
    requestAnimationFrame(() =>
      document
        .getElementById(settingsSectionId(SETTINGS_SECTIONS.gateways))
        ?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
  };

  const confirmEntry = confirm?.kind === "organization" ? rosterBy.get(confirm.uuid) : undefined;

  return (
    <div className="cluster panel accounts-cluster" id={SETTINGS_ACCOUNTS_ANCHOR}>
      <span className="cluster-head eyebrow">{view?.eyebrow ?? "Accounts"}</span>
      {view === null ? (
        <div className="s-section">
          <div className="skel" aria-label="Loading Accounts">
            <i style={{ width: "40%" }} />
            <i style={{ width: "70%" }} />
          </div>
        </div>
      ) : (
        <>
          <AccountStrips
            strips={view.strips}
            legacyFlow={flowNode({ kind: "legacy" })}
            sendKeysBusy={sendKeysBusy}
            sendKeysError={sendKeysError}
            onLegacyReconnect={() => openFlow({ kind: "legacy" })}
            onReconnect={(key) => {
              openFlow({ kind: "account", accountKey: key });
              setScrollTo(key);
            }}
            onSendKeys={sendKeys}
          />
          {view.home !== null ? (
            <Section title={view.home.title} description={view.home.description}>
              <HomeMembershipSelects
                home={view.home}
                onPick={(organizationUuid, accountUuid) =>
                  void update((current) =>
                    homeMembershipPatch(current, organizationUuid, accountUuid),
                  )
                }
              />
            </Section>
          ) : null}
          {view.providers.map((section) => (
            <ProviderSection
              key={section.provider}
              section={section}
              open={open}
              onToggleOpen={(key, next) => setOpen((o) => ({ ...o, [key]: next }))}
              flowFor={(card: AccountCardView) =>
                flowNode({ kind: "account", accountKey: card.key })
              }
              addFlow={flowNode({ kind: "add" })}
              notes={notes}
              busyKey={busyKey}
              onAdd={() => openFlow({ kind: "add" })}
              actions={actions}
              foot={section.provider === "anthropic" ? <ClaudeSectionFoot /> : null}
            />
          ))}
          <GatewaysSection
            view={view.gateways}
            hubHost={hub.hubHost}
            formOpen={gatewayFormOpen}
            notes={gatewayNotes}
            removing={removing}
            onOpenForm={() => setGatewayFormOpen(true)}
            onCloseForm={() => setGatewayFormOpen(false)}
            onConnect={(url, key) =>
              connectGateway({ check: checkGateway, store: setGatewayCredential }, url, key).then(
                (outcome) => {
                  if (outcome.ok) {
                    void qc.invalidateQueries({ queryKey: gatewaysQueryKey() });
                    void qc.invalidateQueries({ queryKey: accountSourcesQueryKey() });
                  }
                  return outcome;
                },
              )
            }
            onRemove={removeGateway}
          />
        </>
      )}
      <UnattributedUsage onConnectGateway={openGatewayForm} />

      {confirm?.kind === "organization" &&
      confirm.mode === "track" &&
      confirmEntry !== undefined ? (
        <TrackConfirm
          key={`track ${confirm.uuid}`}
          label={confirm.label}
          facts={trackingFacts(confirmEntry, confirm.connection, hubConnection, hub.hubSourced)}
          onConfirm={() => update((current) => trackPatch(current, confirm.uuid))}
          onClose={() => setConfirm((c) => (c === confirm ? null : c))}
        />
      ) : null}
      {confirm?.kind === "organization" && confirm.mode === "exclude" ? (
        <ExcludeConfirm
          key={`exclude ${confirm.uuid}`}
          bareLabel={confirmEntry?.label ?? confirm.label}
          shortId={confirm.uuid.slice(0, 8)}
          hub={hubConnection !== "off"}
          onConfirm={() => update((current) => excludePatch(current, confirm.uuid))}
          onClose={() => setConfirm((c) => (c === confirm ? null : c))}
        />
      ) : null}
      {confirm?.kind === "account" ? (
        <ExcludeConfirm
          key={`exclude account ${confirm.key}`}
          bareLabel={confirm.bareLabel}
          shortId={(pendingHashOf(confirm.key) ?? confirm.key).slice(0, 8)}
          hub={hubConnection !== "off"}
          onConfirm={() => update((current) => excludeAccountPatch(current, confirm.key))}
          onClose={() => setConfirm((c) => (c === confirm ? null : c))}
        />
      ) : null}
    </div>
  );
}
