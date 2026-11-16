import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  GATEWAY_CHECK_FAILURE_WORDS,
  GATEWAY_WARNING_WORDS,
  gatewayManagementKeySchema,
  gatewayUrlSchema,
  type GatewayConnectResponse,
  type GatewayWarning,
  type HubGateway,
} from "@maxprice/shared";
import { useHubStatus } from "@/state/use-hub-status";
import { useNowTick } from "@/state/use-now-tick";
import { connectGateway, hubStatusQueryKey, removeGateway } from "@/lib/hub-api";
import { showToast } from "@/lib/toast";
import { gatewayLastRecord, gatewayState } from "@/lib/presentation";

// The Gateways card (ADR-0141 §8): each Gateway the Hub holds and drains, by
// its URL host, with its state and the age of its last record, and Remove;
// and Connect a Gateway…, which posts the URL and the management key to the
// Hub (§7). The key is write-only: the Hub never serves it back. The Popout
// and the Hub page show nothing of Gateways.

export type GatewaysCardActions = {
  connect: (url: string, managementKey: string) => Promise<GatewayConnectResponse>;
  remove: (id: string) => Promise<void>;
};

export function GatewaysCard(): React.ReactElement {
  const qc = useQueryClient();
  const { data: status } = useHubStatus();
  const now = useNowTick();
  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: hubStatusQueryKey() });
  return (
    <GatewaysCardContent
      gateways={status?.gateways ?? []}
      now={now}
      actions={{
        connect: async (url, managementKey) => {
          const answer = await connectGateway({ url, managementKey });
          if (answer.ok) await refresh();
          return answer;
        },
        remove: async (id) => {
          await removeGateway(id);
          await refresh();
        },
      }}
    />
  );
}

export function GatewaysCardContent({
  gateways,
  now,
  actions,
  initialConnect = false,
}: {
  gateways: readonly HubGateway[];
  now: number;
  actions: GatewaysCardActions;
  // Connect open at first render, for the tests.
  initialConnect?: boolean;
}): React.ReactElement {
  const [connecting, setConnecting] = useState(initialConnect);
  // The last Connect's warnings, shown until the card is next used.
  const [warnings, setWarnings] = useState<readonly GatewayWarning[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(gateway: HubGateway): Promise<void> {
    setBusy(gateway.id);
    setError(null);
    try {
      await actions.remove(gateway.id);
      showToast("Gateway removed");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel card" aria-label="Gateways">
      <div className="card-head">
        <span className="eyebrow">Gateways</span>
        <span className="status">{gateways.length === 0 ? "None" : gateways.length}</span>
      </div>
      {gateways.length === 0 ? null : (
        <div>
          {gateways.map((gateway) => {
            const state = gatewayState(gateway.state);
            return (
              <div key={gateway.id} className="mrow">
                <div className="mrow-top">
                  <span aria-hidden className={`dot ${state.dot}`} />
                  <span className="mname">{gateway.urlHost}</span>
                  <span className="mcount">{state.text}</span>
                  <button
                    type="button"
                    className="chip ghost-btn"
                    aria-label={`remove ${gateway.urlHost}`}
                    disabled={busy !== null}
                    onClick={() => void remove(gateway)}
                  >
                    {busy === gateway.id ? "Removing…" : "Remove"}
                  </button>
                </div>
                <p className="msub">{gatewayLastRecord(gateway.lastRecordAt, now)}</p>
              </div>
            );
          })}
        </div>
      )}
      {error !== null ? <p className="err">{error}</p> : null}
      {connecting ? (
        <ConnectFlow
          actions={actions}
          onDone={(next) => {
            setWarnings(next);
            setConnecting(false);
          }}
          onCancel={() => setConnecting(false)}
        />
      ) : (
        <div className="btnrow">
          <button
            type="button"
            className="chip"
            onClick={() => {
              setWarnings([]);
              setError(null);
              setConnecting(true);
            }}
          >
            Connect a Gateway…
          </button>
        </div>
      )}
      {warnings.length === 0 ? null : (
        <div className="inset">
          {warnings.map((warning) => (
            <p key={warning} className="warnline">
              {GATEWAY_WARNING_WORDS[warning]}
            </p>
          ))}
        </div>
      )}
      <p className="hint">
        A Gateway is a proxy your Accounts are used through, such as CLIProxyAPI. The Hub drains its
        usage records; the management key is write-only.
      </p>
    </section>
  );
}

function ConnectFlow({
  actions,
  onDone,
  onCancel,
}: {
  actions: GatewaysCardActions;
  onDone: (warnings: readonly GatewayWarning[]) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [url, setUrl] = useState("");
  const [managementKey, setManagementKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready =
    gatewayUrlSchema.safeParse(url.trim()).success &&
    gatewayManagementKeySchema.safeParse(managementKey.trim()).success;

  async function connect(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const answer = await actions.connect(url.trim(), managementKey.trim());
      if (!answer.ok) {
        setError(GATEWAY_CHECK_FAILURE_WORDS[answer.failure]);
        return;
      }
      showToast("Gateway connected");
      onDone(answer.warnings);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flow mflow">
      <input
        className="input"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Gateway URL, e.g. http://127.0.0.1:8317"
        aria-label="Gateway URL"
      />
      <input
        className="input"
        type="password"
        value={managementKey}
        onChange={(e) => setManagementKey(e.target.value)}
        placeholder="Management key"
        aria-label="Gateway management key"
      />
      <div className="btns">
        <button
          type="button"
          className="chip active"
          disabled={busy || !ready}
          onClick={() => void connect()}
        >
          {busy ? "Checking…" : "Connect"}
        </button>
        <button type="button" className="chip ghost-btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error !== null ? <p className="err">{error}</p> : null}
    </div>
  );
}
