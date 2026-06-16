"use strict";

// Wave EGRESS-TOGGLE (bidirectional) — the generation contract's required ipv6
// policy must FOLLOW the persisted egress mode, falling back to the env default
// when no/garbage state exists (100% backward compatible).
//
// Run with: node node_runtime/node_agent/server.egress_contract.test.js
// Exits non-zero on the first failed assertion.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "egress-contract-"));
process.env.NODE_AGENT_PROXY_ROOT = TMP_ROOT;
const STATE_PATH = path.join(TMP_ROOT, "egress_mode.state");

const SERVER = path.resolve(__dirname, "server.js");

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed += 1;
}
function eq(actual, expected, msg) {
  assert.strictEqual(actual, expected, `${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  passed += 1;
}

// Reload server.js fresh (env default for required policy is module-load-time).
function loadServer(envVal) {
  delete require.cache[require.resolve(SERVER)];
  delete require.cache[require.resolve(path.resolve(__dirname, "egress_mode.js"))];
  if (envVal === undefined) delete process.env.NODE_AGENT_REQUIRED_IPV6_POLICY;
  else process.env.NODE_AGENT_REQUIRED_IPV6_POLICY = envVal;
  return require(SERVER);
}
function setState(content) {
  if (content === null) { try { fs.unlinkSync(STATE_PATH); } catch {} return; }
  fs.writeFileSync(STATE_PATH, content, "utf-8");
}

// ── 1. requiredIpv6PolicyForMode pure mapping ────────────────────
{
  const srv = loadServer(undefined);
  eq(srv.requiredIpv6PolicyForMode("ipv6_only"), "ipv6_only", "ipv6_only → ipv6_only");
  eq(srv.requiredIpv6PolicyForMode("dualstack"), "strict_dual_stack", "dualstack → strict_dual_stack");
  eq(srv.requiredIpv6PolicyForMode("garbage"), null, "garbage → null");
  eq(srv.requiredIpv6PolicyForMode(null), null, "null → null");
}

// ── 2. currentRequiredIpv6Policy follows the state file ──────────
{
  setState("ipv6_only\n");
  const srv = loadServer(undefined);
  eq(srv.currentRequiredIpv6Policy(), "ipv6_only", "state=ipv6_only → ipv6_only");
}
{
  setState("dualstack\n");
  const srv = loadServer(undefined);
  eq(srv.currentRequiredIpv6Policy(), "strict_dual_stack", "state=dualstack → strict_dual_stack");
}

// ── 3. missing state → falls back to env default (backward compat) ─
{
  setState(null);
  const srv = loadServer(undefined);
  eq(srv.currentRequiredIpv6Policy(), srv.PRODUCTION_REQUIRED_IPV6_POLICY, "no state → constant default");
  eq(srv.currentRequiredIpv6Policy(), "strict_dual_stack", "no state + no env → strict_dual_stack");
}

// ── 4. malformed state → falls back to env default ───────────────
{
  setState("nonsense\n");
  const srv = loadServer("ipv6_required");
  eq(srv.currentRequiredIpv6Policy(), "ipv6_required", "malformed state → env override default");
}

try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
console.log(`server.egress_contract.test.js — all ${passed} assertions passed`);
