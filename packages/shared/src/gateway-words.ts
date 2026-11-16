import type { GatewayCheckFailure, GatewayState, GatewayWarning } from "./gateway";

// The words every surface gives a Gateway (ADR-0141 §7, §8; #673): the
// Desktop's Settings › Accounts, the hub tray app's Gateways card, and the
// Headless client's and Headless Hub's `gateway` verbs and `status` lines.
// One map each, so the four read alike; a surface adds its own framing (a
// remedy, a trailing `Nothing was stored.`) around them, never other words.

// A Gateway's state as its drainer last found it. `statistics-off` is the
// drainer's inference: its credentials served requests while its queue gave
// nothing, as with its usage statistics off or another consumer taking the
// records (§6). `unauthorized` is also a Gateway whose key the Hub could not
// read: connect it again.
export const GATEWAY_STATE_WORDS: Readonly<Record<GatewayState, string>> = {
  draining: "Draining",
  "statistics-off": "Statistics off",
  unreachable: "Unreachable",
  unauthorized: "Key refused",
  error: "Error",
};

// How a surface marks each state: draining is good; `statistics-off` a
// warning, since the Gateway answers but its queue gives nothing; the rest
// are faults.
export type GatewayStateTone = "good" | "warn" | "bad";
export const GATEWAY_STATE_TONE: Readonly<Record<GatewayState, GatewayStateTone>> = {
  draining: "good",
  "statistics-off": "warn",
  unreachable: "bad",
  unauthorized: "bad",
  error: "bad",
};

// What every Connect that passes says (§7 as amended 2026-11-10): neither
// call MaxPrice makes shows the queue's retention or whether another consumer
// reads it, so both are said every time. Whoever drains the Gateway, a
// client or the Hub, the words hold.
export const GATEWAY_WARNING_WORDS: Readonly<Record<GatewayWarning, string>> = {
  retention:
    "Set the Gateway's usage queue retention to 3600 seconds or more, so its records wait for MaxPrice between reads.",
  "only-consumer":
    "MaxPrice must be the only consumer of the Gateway's usage queue: anything else that drains it takes records MaxPrice then never sees.",
};

// Why a Connect check failed: nothing was stored.
export const GATEWAY_CHECK_FAILURE_WORDS: Readonly<Record<GatewayCheckFailure, string>> = {
  unreachable: "The Gateway didn't answer at that URL.",
  unauthorized: "The Gateway refused that management key.",
  error: "The Gateway answered, but not as CLIProxyAPI's management API does.",
};
