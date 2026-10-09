"use strict";

// ── Remote OpenClaw profile: data shape + validation ──
//
// Pure schema helpers for `prefs.remoteOpenclaw`. Used by:
//   - prefs.js normalizeRemoteOpenclaw (drop bad data on load)
//   - settings-actions.js field validator (reject bad input on write)
//
// SECURITY: `password` / `token` are gateway credentials. They live in prefs
// (Electron userData) and must never be written to logs, crash reports, or
// this repository. normalizeRemoteOpenclaw is deliberately total — it never
// throws, so a corrupt prefs entry can't brick settings load.

const { AUTH_MODES, normalizeGatewayUrl } = require("./remote-openclaw-protocol");

const MAX_URL_LENGTH = 2048;
const MAX_CREDENTIAL_LENGTH = 1024;
const MAX_FILTER_LENGTH = 128;

function getDefaults() {
  return {
    enabled: false,
    url: "",
    authMode: "password",
    password: "",
    token: "",
    agentFilter: "",
  };
}

function normalizeRemoteOpenclaw(value) {
  const defaults = getDefaults();
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  return {
    enabled: value.enabled === true,
    url: typeof value.url === "string" ? value.url.trim().slice(0, MAX_URL_LENGTH) : "",
    authMode: AUTH_MODES.has(value.authMode) ? value.authMode : "password",
    password:
      typeof value.password === "string" ? value.password.slice(0, MAX_CREDENTIAL_LENGTH) : "",
    token: typeof value.token === "string" ? value.token.slice(0, MAX_CREDENTIAL_LENGTH) : "",
    agentFilter:
      typeof value.agentFilter === "string"
        ? value.agentFilter.trim().slice(0, MAX_FILTER_LENGTH)
        : "",
  };
}

// Only an *enabled* profile has to be complete; a disabled one may stay blank
// so the user can fill fields in any order.
function validateRemoteOpenclaw(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "error", message: "remoteOpenclaw must be a plain object" };
  }
  if (value.authMode !== undefined && !AUTH_MODES.has(value.authMode)) {
    return { status: "error", message: "remoteOpenclaw.authMode must be 'password' or 'token'" };
  }
  if (value.enabled !== true) return { status: "ok" };

  if (!normalizeGatewayUrl(value.url)) {
    return { status: "error", message: "remoteOpenclaw.url must be a host or ws(s):// URL" };
  }
  const mode = value.authMode === "token" ? "token" : "password";
  const credential = mode === "token" ? value.token : value.password;
  if (typeof credential !== "string" || !credential) {
    return { status: "error", message: `remoteOpenclaw.${mode} is required when enabled` };
  }
  return { status: "ok" };
}

module.exports = {
  getDefaults,
  normalizeRemoteOpenclaw,
  validateRemoteOpenclaw,
};
