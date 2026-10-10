"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  GATEWAY_DEFAULT_PORT,
  GATEWAY_PROTOCOL_VERSION,
  buildConnectParams,
  isHeartbeatGatewayEvent,
  mapGatewayEvent,
  normalizeGatewayUrl,
} = require("../src/remote-openclaw-protocol");

test("gateway url normalization accepts a bare host and assumes TLS", () => {
  assert.equal(normalizeGatewayUrl("openclaw.example.com"), "wss://openclaw.example.com/");
  assert.equal(normalizeGatewayUrl("  openclaw.example.com  "), "wss://openclaw.example.com/");
});

test("gateway url normalization maps schemes and defaults the gateway port", () => {
  assert.equal(normalizeGatewayUrl("https://gw.example.com"), "wss://gw.example.com/");
  assert.equal(normalizeGatewayUrl("http://gw.example.com"), `ws://gw.example.com:${GATEWAY_DEFAULT_PORT}/`);
  assert.equal(normalizeGatewayUrl("ws://gw.example.com"), `ws://gw.example.com:${GATEWAY_DEFAULT_PORT}/`);
  // An explicit port must survive — including a non-default one on wss://.
  assert.equal(normalizeGatewayUrl("wss://gw.example.com:8443"), "wss://gw.example.com:8443/");
  assert.equal(normalizeGatewayUrl("http://gw.example.com:19001"), "ws://gw.example.com:19001/");
});

test("gateway url normalization keeps a non-root path and rejects junk", () => {
  assert.equal(normalizeGatewayUrl("https://gw.example.com/openclaw"), "wss://gw.example.com/openclaw");
  for (const bad of ["", "   ", null, undefined, 42, "http://", "::::"]) {
    assert.equal(normalizeGatewayUrl(bad), "", `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("connect params carry minProtocol/maxProtocol and nest credentials under auth", () => {
  const params = buildConnectParams({ password: "pw", version: "1.2.0" });
  assert.equal(params.minProtocol, GATEWAY_PROTOCOL_VERSION);
  assert.equal(params.maxProtocol, GATEWAY_PROTOCOL_VERSION);
  assert.deepEqual(params.auth, { password: "pw" });
  assert.equal(params.client.version, "1.2.0");
  // The two mistakes that cost a round trip each on the real gateway:
  assert.equal(params.password, undefined, "password must not sit at the root");
  assert.equal(typeof params.client.id, "string");
});

test("connect params honour an advertised protocol version and token auth", () => {
  const params = buildConnectParams({ protocolVersion: 5, token: "tok" });
  assert.equal(params.minProtocol, 5);
  assert.equal(params.maxProtocol, 5);
  assert.deepEqual(params.auth, { token: "tok" });
});

test("connect params omit absent credentials rather than sending blanks", () => {
  assert.deepEqual(buildConnectParams({}).auth, {});
});

test("heartbeat broadcasts never move the pet", () => {
  for (const event of ["tick", "health", "presence", "connect.challenge"]) {
    assert.equal(isHeartbeatGatewayEvent(event), true, `${event} should be a heartbeat`);
    assert.equal(mapGatewayEvent(event, {}), null, `${event} must not map to a state`);
  }
});

test("gateway activity maps onto the pet state vocabulary", () => {
  assert.deepEqual(mapGatewayEvent("session.typing", {}), { state: "thinking", event: "UserPromptSubmit" });
  assert.deepEqual(mapGatewayEvent("session.tool", {}), { state: "working", event: "PreToolUse" });
  assert.deepEqual(mapGatewayEvent("session.approval", {}), { state: "attention", event: "Stop" });
  assert.deepEqual(mapGatewayEvent("exec.approval.requested", {}), { state: "attention", event: "Stop" });
  assert.deepEqual(mapGatewayEvent("sessions.changed", {}), { state: "idle", event: "SessionStart" });
  assert.deepEqual(mapGatewayEvent("shutdown", {}), { state: "sleeping", event: "SessionEnd" });
});

test("unknown session activity still shows as working, other unknown events are ignored", () => {
  assert.deepEqual(mapGatewayEvent("session.something-new", {}), { state: "working", event: "PreToolUse" });
  assert.equal(mapGatewayEvent("device.pair.requested", {}), null);
  assert.equal(mapGatewayEvent("", {}), null);
  assert.equal(mapGatewayEvent(undefined, {}), null);
});

test("gateway event mapping reuses the local plugin's event vocabulary", () => {
  // agents/openclaw.js eventMap keys — the remote path must speak the same
  // language so downstream state handling is identical either way.
  const known = new Set([
    "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
    "PostToolUseFailure", "Stop", "StopFailure", "PreCompact", "PostCompact", "SessionEnd",
  ]);
  for (const event of [
    "session.typing", "session.tool", "session.message", "session.approval",
    "sessions.changed", "shutdown", "session.whatever",
  ]) {
    const mapped = mapGatewayEvent(event, {});
    assert.ok(known.has(mapped.event), `${event} produced an unknown event ${mapped.event}`);
  }
});
