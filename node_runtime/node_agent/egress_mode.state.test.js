"use strict";

// Wave EGRESS-TOGGLE (bidirectional) — egress-mode state persistence.
//
// Covers: applyEgressMode writes a valid state file (even with zero cfgs), and
// readEgressModeState round-trips a written value / rejects garbage / returns
// null when the file is missing. Drives the state path at a temp dir via
// NODE_AGENT_PROXY_ROOT so it never touches /opt/netrun.
//
// Run with: node node_runtime/node_agent/egress_mode.state.test.js
// Exits non-zero on the first failed assertion.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Point PROXY_ROOT at a throwaway temp dir BEFORE requiring the module
// (PROXY_ROOT / EGRESS_MODE_STATE_PATH are computed at module-eval time).
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "egress-state-"));
process.env.NODE_AGENT_PROXY_ROOT = TMP_ROOT;

const egress = require(path.resolve(__dirname, "egress_mode.js"));

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed += 1;
}
function eq(actual, expected, msg) {
  assert.strictEqual(actual, expected, `${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  passed += 1;
}

const STATE_PATH = egress.EGRESS_MODE_STATE_PATH;
eq(STATE_PATH, path.join(TMP_ROOT, "egress_mode.state"), "state path is under PROXY_ROOT");

// ── 1. missing state file → null ─────────────────────────────────
ok(!fs.existsSync(STATE_PATH), "no state file initially");
eq(egress.readEgressModeState(), null, "readEgressModeState() with no file → null");

// ── 2. applyEgressMode persists the mode even with ZERO cfgs ──────
// (3proxy cfg dir doesn't exist under the temp root → listConfigPaths()=[],
//  cfgs_rewritten=0, but the state MUST still be recorded.)
(async () => {
  const res = await egress.applyEgressMode("ipv6_only");
  eq(res.ok, true, "applyEgressMode ok with no cfgs");
  eq(res.cfgs_rewritten, 0, "no cfgs rewritten on fresh node");
  ok(fs.existsSync(STATE_PATH), "state file written even with 0 cfgs");
  eq(egress.readEgressModeState(), "ipv6_only", "readEgressModeState round-trips ipv6_only");

  // ── 3. re-apply the other mode overwrites state ────────────────
  await egress.applyEgressMode("dualstack");
  eq(egress.readEgressModeState(), "dualstack", "readEgressModeState round-trips dualstack");

  // ── 4. malformed / unknown content → null ──────────────────────
  fs.writeFileSync(STATE_PATH, "garbage_mode\n", "utf-8");
  eq(egress.readEgressModeState(), null, "malformed state content → null");

  fs.writeFileSync(STATE_PATH, "  ipv6_only  \n", "utf-8");
  eq(egress.readEgressModeState(), "ipv6_only", "whitespace-padded valid value trims to ipv6_only");

  // cleanup
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}

  console.log(`egress_mode.state.test.js — all ${passed} assertions passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
