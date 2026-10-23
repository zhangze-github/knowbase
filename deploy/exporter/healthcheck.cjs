#!/usr/bin/env node
"use strict";

const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

function fail(reason) {
  // Never print state contents: last_error can contain upstream diagnostic data.
  console.error(`Exporter unhealthy: ${reason}`);
  process.exit(1);
}

const maxAge = Number(process.env.KNOWBASE_EXPORTER_HEALTH_MAX_AGE_SECONDS || "600");
if (!Number.isFinite(maxAge) || maxAge <= 0) fail("invalid maximum success age");

const file = process.env.KNOWBASE_EXPORTER_HEALTH_FILE || join(
  process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), ".config"),
  "knowbase", "exporter-health.json",
);
let state;
try {
  state = JSON.parse(readFileSync(file, "utf8"));
} catch {
  fail("health state missing or unreadable");
}
if (!state || typeof state !== "object" || Array.isArray(state)) fail("malformed health state");

const now = Date.now();
function timestamp(value) {
  if (typeof value !== "string") fail("malformed health timestamp");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > now) fail("invalid health timestamp");
  return parsed;
}

timestamp(state.started_at);
if (state.last_cycle_at !== undefined) timestamp(state.last_cycle_at);
if (state.last_error !== undefined && typeof state.last_error !== "string") fail("malformed health error");
if (state.last_error) fail("latest cycle failed");
if (state.last_success_at === undefined) fail("no successful push since startup");
if (now - timestamp(state.last_success_at) > maxAge * 1000) fail("last successful push is stale");
process.exit(0);
