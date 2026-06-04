"use strict";

// Wave NODE-NEW-MODERNIZE — the node-agent's egress policy default must be
// strict_dual_stack (ipv6_only is deprecated/dead) so a freshly cloud-init'd
// node enforces the right family policy with NO env dependency, while the
// NODE_AGENT_REQUIRED_IPV6_POLICY env still overrides it when set.
//
// Run with: node node_runtime/node_agent/server.ipv6_default.test.js
// Exits non-zero on the first failed assertion.

const assert = require("assert");
const path = require("path");

const MODULE = path.resolve(__dirname, "server.js");

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed += 1;
}

// The default is computed once at module-eval time from process.env, so we
// reload the module fresh with the env we want each time.
function loadWithEnv(envVal) {
  delete require.cache[require.resolve(MODULE)];
  if (envVal === undefined) {
    delete process.env.NODE_AGENT_REQUIRED_IPV6_POLICY;
  } else {
    process.env.NODE_AGENT_REQUIRED_IPV6_POLICY = envVal;
  }
  return require(MODULE);
}

// ── 1. No env → strict_dual_stack (the new default) ──────────────
ok(
  loadWithEnv(undefined).PRODUCTION_REQUIRED_IPV6_POLICY === "strict_dual_stack",
  "no env → default strict_dual_stack (ipv6_only is dead)"
);

// ── 2. env override honoured for a valid policy ──────────────────
ok(
  loadWithEnv("ipv6_required").PRODUCTION_REQUIRED_IPV6_POLICY === "ipv6_required",
  "env=ipv6_required → ipv6_required (override works)"
);
ok(
  loadWithEnv("ipv6_only").PRODUCTION_REQUIRED_IPV6_POLICY === "ipv6_only",
  "env=ipv6_only → ipv6_only (explicit opt-in still possible)"
);

// ── 3. invalid env → falls back to strict_dual_stack (not ipv6_only) ─
ok(
  loadWithEnv("garbage").PRODUCTION_REQUIRED_IPV6_POLICY === "strict_dual_stack",
  "invalid env → fallback strict_dual_stack"
);

// ── 4. empty env → strict_dual_stack ─────────────────────────────
ok(
  loadWithEnv("").PRODUCTION_REQUIRED_IPV6_POLICY === "strict_dual_stack",
  "empty env → default strict_dual_stack"
);

// ── 5. collectJobParams ipv6 fallback no longer defaults ipv6_only ─
const { collectJobParams } = loadWithEnv(undefined);
const diag = collectJobParams({}, []);
ok(
  diag.profile.intended_ipv6_policy === "strict_dual_stack",
  "collectJobParams empty body → intended_ipv6_policy strict_dual_stack (no ipv6_only hardcode)"
);

console.log(`server.ipv6_default.test.js — all ${passed} assertions passed`);
