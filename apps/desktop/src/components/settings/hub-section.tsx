import { useEffect, useMemo, useState } from "react";
import { isRecognizedTailnetHost, isValidHubPassword, normalizeHubUrl } from "@maxprice/shared";
import { useLiveStatus } from "@/state/use-live-status";
import { useSettings, useUpdateSettings } from "@/state/use-settings";
import {
  readHubPassword,
  writeHubPassword,
  pushHubConfigToSidecar,
  disconnectHub,
} from "@/lib/hub-config";
import { hubConnectionDot, hubConnectionLabel, hubConnectionTextClass } from "@/lib/hub-status";
import { isStale, STALE_HUB_LINE } from "@/lib/stale-status";
import { seedPercent } from "@/lib/machines";
import { insideTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { dotVariant } from "@/lib/dot-variant";

// Settings → Usage hub (ADR-0035/0037). Point at an always-on hub that polls
// usage limits for every machine: the URL lives in settings.json (non-secret),
// the optional password in the OS keychain beside the usage credential. Both
// push to the sidecar over loopback, which owns the actual hub connection. Live
// connection state comes from the `status:changed` SSE snapshot's `hubConnection`.
//
// M6 (T7): the three checkboxes are glass switches (presentation only — the
// semantics stay boolean, labels + indented sub-lines verbatim); the two
// LOAD-BEARING amber warnings (unrecognized host, pre-event-sync hub degrade)
// are T1 warn insets, while validation errors stay bare `--bad` text lines
// and the transient seed progress stays a dim text line.

// One glass switch row — the chart-foot toggle recipe reskinning a settings
// boolean (role="switch", the visible label is the accessible name).
function SwitchRow({
  checked,
  disabled,
  onToggle,
  children,
}: {
  checked: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onToggle(!checked)}
      className="toggle"
    >
      <span className="track" aria-hidden />
      {children}
    </button>
  );
}

export function HubSection(): React.ReactElement {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const connection = useLiveStatus((s) => s.hubConnection);
  // THE STALE RULE (lib/stale-status), shared verbatim with the sidebar foot —
  // which renders simultaneously with this page. `hubConnection` is a mirror of
  // sidecar-owned state refreshed only by `status:changed` frames, so once the
  // SSE channel is gone it holds its last value forever; without this, the foot
  // would say "hub state unknown" while this line, inches away, asserted a green
  // "Connected — hub is polling" that nobody has confirmed since the channel
  // dropped — on the page a user opens to diagnose exactly that.
  //
  // Only the stale rule is shared. The foot's sticky-connecting rule is
  // deliberately NOT applied here: steadiness is what a permanent glance surface
  // wants, but on this action surface it would swallow feedback, holding the old
  // reading so that pressing Save while the hub is down changed nothing on
  // screen. This line keeps showing the live `connecting` state.
  const connectionState = useLiveStatus((s) => s.connectionState);
  // ADR-0041 (M6): mid-seed the sidecar drains its fleet replica from cursor 0 —
  // render the transient progress percent; `hubEventsDegraded` marks a reachable
  // hub whose status carried no `events` object (the amber honesty line). That
  // absence has TWO causes the wire can't tell apart — a pre-M4 hub that doesn't
  // speak event sync at all, and a current hub whose fleet event archive failed
  // to load at boot (what the hub's own console reports as "Restart the hub") —
  // so the line names both remedies rather than asserting the one it can't
  // distinguish.
  const hubSeed = useLiveStatus((s) => s.hubSeed);
  const eventsDegraded = useLiveStatus((s) => s.hubEventsDegraded);

  // Local editable copy of the settings URL — seeded from settings, re-synced
  // when the settings query resolves after first paint. The password is NEVER
  // echoed from the keychain: the field always starts empty.
  const [url, setUrl] = useState(settings?.hubUrl ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrl(settings?.hubUrl ?? "");
  }, [settings?.hubUrl]);

  const configured = (settings?.hubUrl ?? "") !== "";

  // Unlike the foot, `off` is NOT carved out ahead of stale here. The foot hides
  // its hub line on `off` because a line's PRESENCE there advertises a feature,
  // and a machine with no hub shouldn't carry a permanent reminder of one — an
  // argument about whether to draw at all, which doesn't apply to a section the
  // user navigated to. `off` is the same unconfirmable mirror as every other
  // state, so it softens with them; the URL field directly below stays the
  // local, always-true answer to "is a hub configured".
  const stale = isStale(connectionState);

  // Warn (never block) when the hub location isn't recognizably a tailnet or
  // loopback address (F2a): with auto-heal on, this machine POSTs its claude.ai
  // session key to the hub over plain HTTP, so an unrecognized host is worth a
  // passive heads-up. Derived from the NORMALIZED url so a bare host is judged
  // by its real hostname; new URL().hostname keeps IPv6 brackets, so strip them
  // before classifying. A bare single-label MagicDNS name (no ".ts.net") can't
  // be positively placed on the tailnet and so warns — accepted.
  const unrecognizedHubHost = useMemo(() => {
    try {
      const normalized = normalizeHubUrl(url);
      if (normalized === "") return null;
      const host = new URL(normalized).hostname.replace(/^\[|\]$/g, "");
      if (host === "" || isRecognizedTailnetHost(host)) return null;
      return host;
    } catch {
      return null; // unparseable — connect() already surfaces that error
    }
  }, [url]);

  // Read the stored keychain password (Tauri-only; null outside Tauri or when
  // unset) and reject a value poisoned by an earlier bad paste — one that can't
  // form a valid Authorization header fails every push opaquely as a generic
  // "unreachable" (F18). Throws a user-facing Error on a corrupted value; both
  // connect() and applyAutoHeal() catch it into the section error and skip the
  // push (self-healing the keychain by prompting a re-entry).
  async function readStoredHubPassword(): Promise<string | null> {
    const stored = insideTauri() ? await readHubPassword() : null;
    if (stored !== null && stored !== "" && !isValidHubPassword(stored)) {
      throw new Error("The stored hub password looks corrupted — re-enter it.");
    }
    return stored;
  }

  async function connect(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // Normalize the typed location into a fetchable absolute URL (default
      // scheme + port) BEFORE anything is persisted or pushed — a bare
      // "localhost" is otherwise scheme-less and the sidecar's fetch rejects it
      // with ERR_INVALID_URL, swallowed into a generic "unreachable" (ADR-0035).
      let normalizedUrl: string;
      try {
        normalizedUrl = normalizeHubUrl(url);
      } catch {
        setError("Enter a valid hub URL, e.g. http://localhost:47100");
        return;
      }

      // Persist the password to the keychain when one was entered. When the
      // field is left empty (re-saving a URL without re-typing the password)
      // keep the stored password and push that instead. The keychain calls need
      // a Tauri host; standalone dev skips them and pushes unauthenticated.
      const trimmedPassword = password.trim();
      // Reject a header-hostile value (whitespace / non-ASCII / >128 chars)
      // before it reaches the keychain or the sidecar's fetch (ADR-0037).
      if (trimmedPassword !== "" && !isValidHubPassword(trimmedPassword)) {
        setError("That password can't be used — printable ASCII, no spaces, max 128 chars.");
        return;
      }
      if (insideTauri() && trimmedPassword !== "") {
        await writeHubPassword(trimmedPassword);
      }
      // A typed password was validated above; when the field was left blank,
      // fall back to the stored keychain value (validated + self-healed by the
      // shared helper, which throws on a corrupted value).
      const pushPassword = trimmedPassword !== "" ? trimmedPassword : await readStoredHubPassword();
      setUrl(normalizedUrl);
      await update({ hubUrl: normalizedUrl });
      await pushHubConfigToSidecar(normalizedUrl, pushPassword, settings?.hubAutoHeal ?? true);
      setPassword("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // The keychain → settings → sidecar teardown ordering lives in
      // disconnectHub (F36/F46); this caller just owns the local UI reset.
      await disconnectHub(() => update({ hubUrl: "" }));
      setUrl("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Toggling auto-heal persists the setting and — when a hub is configured —
  // re-pushes the config immediately with the stored password, mirroring
  // connect()'s keychain handling. Outside Tauri (standalone dev) there is no
  // keychain: persist only; the env-driven sidecar picks its own value.
  async function applyAutoHeal(next: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await update({ hubAutoHeal: next });
      if (configured) {
        // Same corrupted-keychain guard connect() applies — auto-heal can POST
        // this machine's claude.ai key, so a poisoned stored password must
        // surface the corrupted-password error (the toggle update above already
        // stands) rather than an opaque "unreachable" from the sidecar (F18).
        const stored = await readStoredHubPassword();
        await pushHubConfigToSidecar((settings?.hubUrl ?? "").trim(), stored, next);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // The status line's three presentation pieces, resolved together so the dot,
  // the text colour, and the label can never disagree about whether we still
  // believe the mirror. `variant` is the glass `.dot` triad, which is what this
  // line has always drawn — `dotVariant` translates hub-status.ts' Tailwind
  // `bg-*` class into it, so the frozen constant's `variant` drops straight in.
  const line = stale
    ? {
        variant: STALE_HUB_LINE.variant,
        textClass: STALE_HUB_LINE.textClass,
        label: STALE_HUB_LINE.title,
      }
    : {
        variant: dotVariant(hubConnectionDot(connection)),
        textClass: hubConnectionTextClass(connection),
        label: hubConnectionLabel(connection),
      };

  return (
    <>
      <div className="status-line">
        <span className={cn("dot", line.variant)} aria-hidden />
        <span className={line.textClass}>{line.label}</span>
      </div>

      {hubSeed !== null ? (
        <p className="hint-line">Syncing fleet history — {seedPercent(hubSeed)}%</p>
      ) : null}

      <input
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="http://my-desktop.tailnet.ts.net:47100"
        aria-label="hub URL"
        className="input"
      />
      {unrecognizedHubHost !== null ? (
        <div className="inset warn self-stretch">
          <p className="lead">
            <code>{unrecognizedHubHost}</code> isn&apos;t a recognizable tailnet or loopback
            address. With auto-heal on, this machine&apos;s claude.ai credential may be sent to it
            over plain HTTP.
          </p>
        </div>
      ) : null}
      <div className="row-line">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="hub password (leave blank if none)"
          aria-label="hub password"
          className="input"
          // Allow pressing Enter to connect
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim() !== "" && !busy) void connect();
          }}
        />
        <button
          type="button"
          className="chip"
          disabled={busy || url.trim() === ""}
          onClick={() => void connect()}
        >
          {busy ? "Saving…" : configured ? "Save" : "Connect"}
        </button>
        {configured ? (
          <button type="button" className="chip" disabled={busy} onClick={() => void disconnect()}>
            Disconnect
          </button>
        ) : null}
      </div>

      {error !== null ? <p className="err">{error}</p> : null}

      <SwitchRow
        checked={settings?.hubAutoHeal ?? true}
        disabled={busy}
        onToggle={(next) => void applyAutoHeal(next)}
      >
        Auto-heal: push this machine&apos;s Claude credential when the hub&apos;s key dies
      </SwitchRow>

      <SwitchRow
        checked={settings?.hubShareEvents ?? true}
        disabled={busy}
        onToggle={(next) => void update({ hubShareEvents: next })}
      >
        Share usage events: push this machine&apos;s usage to the hub&apos;s fleet archive
      </SwitchRow>
      <p className="subline">Events already shared stay on the hub.</p>

      <SwitchRow
        checked={settings?.hubFleetReplica ?? true}
        disabled={busy}
        onToggle={(next) => void update({ hubFleetReplica: next })}
      >
        Fleet replica: mirror every machine&apos;s usage events locally
      </SwitchRow>
      <p className="subline">
        The machine filter, machine group-by, and machine columns need this.
      </p>

      {configured && eventsDegraded ? (
        <div className="inset warn self-stretch">
          <p className="lead">
            Fleet event sync is unavailable on this hub — update MaxPrice Hub on the hub machine if
            it&apos;s an older version; otherwise check the hub console and restart it. Usage-limit
            sync still works.
          </p>
        </div>
      ) : null}

      <p className="helper">
        The hub URL is stored in settings.json; the password (if the hub has one) is stored in the
        OS keychain. Leave the password blank when re-saving to keep the stored one. Set or clear
        the hub&apos;s password on the hub machine — from the MaxPrice Hub console, or{" "}
        <code>maxprice-hub password set</code> on a headless hub. While connected, the Claude
        account status above reflects the hub&apos;s credential. With auto-heal on (the default),
        this machine re-keys the hub automatically when the hub&apos;s Claude session key expires.
      </p>
    </>
  );
}
