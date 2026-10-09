"use strict";

// ── Remote OpenClaw gateway protocol ──
//
// Talks to an OpenClaw gateway over WebSocket (the same endpoint the Control
// UI uses) and translates its broadcast events into the pet's state
// vocabulary.
//
// Wire protocol, verified against gateway 2026.10.1-beta.2 (protocol 4):
//
//   1. server → client  { type:"event", event:"connect.challenge",
//                         payload:{ nonce, ts, capabilities } }
//   2. client → server  { type:"req", id, method:"connect", params:{...} }
//   3. server → client  { type:"res", id, ok:true,
//                         payload:{ type:"hello-ok", protocol, server,
//                                   features, snapshot, auth, policy } }
//
// Two details that are easy to get wrong and cost a round trip each:
//
//   - `minProtocol` / `maxProtocol` are REQUIRED. A mismatch is answered with
//     PROTOCOL_MISMATCH carrying `expectedProtocol` and `minimumProbeProtocol`
//     in `error.details`, so the caller can retry with the advertised value
//     instead of guessing.
//   - Credentials belong inside `auth`. Putting `password` at the root is
//     rejected outright ("unexpected property 'password'").
//
// IMPORTANT: the gateway broadcasts *semantic* events (`session.tool`,
// `session.typing`, `session.approval`, ...) — NOT the plugin hook names that
// hooks/openclaw-plugin consumes (`before_tool_call`, `model_call_started`,
// ...). Those hook names are process-internal to the plugin and never appear
// on the wire, so the mapping below cannot reuse the plugin's table.

const os = require("os");

const GATEWAY_DEFAULT_PORT = 18789;
// Advertised by gateway 2026.10.1-beta.2. Kept as a starting value only —
// see PROTOCOL_MISMATCH handling above.
const GATEWAY_PROTOCOL_VERSION = 4;

// `client.id` is an enum on the gateway side; `gateway-client` is the generic
// non-browser entry. `openclaw-control-ui` is reserved for the web UI.
const GATEWAY_CLIENT_ID = "gateway-client";
const GATEWAY_CLIENT_MODE = "ui";
const GATEWAY_CLIENT_DISPLAY_NAME = "Clawd on Desk";

const AUTH_MODES = new Set(["password", "token"]);

// Broadcasts that carry no user-visible activity. Forwarding these would keep
// the pet twitching on an otherwise idle gateway (tick fires every 30s by
// default — see `policy.tickIntervalMs` in the hello payload).
const HEARTBEAT_EVENTS = new Set([
  "connect.challenge",
  "tick",
  "health",
  "heartbeat",
  "presence",
  "models.snapshot",
]);

// gateway event → pet activity.
// `state` must be one of the states the renderer knows; `event` reuses the
// vocabulary of agents/openclaw.js `eventMap` keys so the remote path and the
// local plugin path produce the same shape downstream.
const GATEWAY_EVENT_MAP = new Map([
  // Model is producing output / a turn is being submitted.
  ["session.typing", { state: "thinking", event: "UserPromptSubmit" }],
  ["session.narration", { state: "thinking", event: "UserPromptSubmit" }],
  // A tool is being invoked, or an operation is in flight.
  ["session.tool", { state: "working", event: "PreToolUse" }],
  ["session.operation", { state: "working", event: "PreToolUse" }],
  // Output landed.
  ["session.message", { state: "working", event: "PostToolUse" }],
  ["session.observer", { state: "working", event: "PostToolUse" }],
  // The agent needs a human — this is what the pet's `attention` state is for.
  ["session.approval", { state: "attention", event: "Stop" }],
  ["exec.approval.requested", { state: "attention", event: "Stop" }],
  ["plugin.approval.requested", { state: "attention", event: "Stop" }],
  ["openclaw.approval.requested", { state: "attention", event: "Stop" }],
  ["question.requested", { state: "attention", event: "Stop" }],
  // Waiting is over, work resumed.
  ["exec.approval.resolved", { state: "working", event: "PostToolUse" }],
  ["question.resolved", { state: "working", event: "PostToolUse" }],
  // Session list changed: something woke up.
  ["sessions.changed", { state: "idle", event: "SessionStart" }],
  ["shutdown", { state: "sleeping", event: "SessionEnd" }],
]);

function normalizeGatewayUrl(input) {
  if (typeof input !== "string") return "";
  const raw = input.trim();
  if (!raw) return "";

  // Accept a bare host (`openclaw.example.com`) by assuming TLS, which is how
  // these gateways are normally exposed through a reverse proxy.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;

  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return "";
  }

  const secure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const scheme = secure ? "wss:" : "ws:";
  // Only ws:// falls back to the gateway port; wss:// is 443 (or whatever the
  // proxy terminates on), so leave it implicit.
  const port = parsed.port || (secure ? "" : String(GATEWAY_DEFAULT_PORT));
  const host = parsed.hostname;
  if (!host) return "";

  // The gateway serves its WebSocket on the root path.
  const pathname = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/";

  return `${scheme}//${host}${port ? `:${port}` : ""}${pathname}`;
}

function buildConnectParams(options = {}) {
  const protocolVersion = Number.isInteger(options.protocolVersion)
    ? options.protocolVersion
    : GATEWAY_PROTOCOL_VERSION;

  // Both modes may be present; the gateway picks what it accepts. Sending a
  // password is what a password-mode gateway expects — token-mode gateways
  // ignore it in favour of `auth.token`.
  const auth = {};
  if (typeof options.password === "string" && options.password) auth.password = options.password;
  if (typeof options.token === "string" && options.token) auth.token = options.token;

  return {
    minProtocol: protocolVersion,
    maxProtocol: protocolVersion,
    client: {
      id: options.clientId || GATEWAY_CLIENT_ID,
      displayName: options.displayName || GATEWAY_CLIENT_DISPLAY_NAME,
      version: typeof options.version === "string" && options.version ? options.version : "0.0.0",
      platform: options.platform || os.platform(),
      mode: options.mode || GATEWAY_CLIENT_MODE,
    },
    auth,
  };
}

function isHeartbeatGatewayEvent(eventName) {
  return typeof eventName === "string" && HEARTBEAT_EVENTS.has(eventName);
}

// Returns { state, event } for an activity-bearing broadcast, or null when the
// event should not move the pet.
//
// TODO(payload refinement): several gateway events carry a phase/error field
// in their payload (a tool call reporting completion vs. start, a message
// marked final, an approval that was denied). Once those payloads are captured
// from a live session, refine here so `session.tool` can distinguish
// PreToolUse from PostToolUseFailure instead of always reporting PreToolUse.
function mapGatewayEvent(eventName, payload = {}) {
  if (typeof eventName !== "string" || !eventName) return null;
  if (HEARTBEAT_EVENTS.has(eventName)) return null;

  const mapped = GATEWAY_EVENT_MAP.get(eventName);
  if (mapped) return { state: mapped.state, event: mapped.event };

  // Unknown `session.*` activity still means "the gateway is doing something",
  // so surface it as working rather than letting the pet sit on a stale state.
  // Unknown non-session events (device pairing, terminal, updates, ...) are
  // ignored — they are not agent activity.
  if (eventName.startsWith("session.")) {
    return { state: "working", event: "PreToolUse" };
  }
  return null;
}

module.exports = {
  AUTH_MODES,
  GATEWAY_CLIENT_DISPLAY_NAME,
  GATEWAY_CLIENT_ID,
  GATEWAY_CLIENT_MODE,
  GATEWAY_DEFAULT_PORT,
  GATEWAY_EVENT_MAP,
  GATEWAY_PROTOCOL_VERSION,
  HEARTBEAT_EVENTS,
  buildConnectParams,
  isHeartbeatGatewayEvent,
  mapGatewayEvent,
  normalizeGatewayUrl,
};
