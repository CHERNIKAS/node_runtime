"use strict";

// Audit WI-5 (H16) — unit tests for the 3proxy cfg disable/enable lifecycle.
// A disabled port's cfg must be renamed OUT of the reboot restore glob
// (`3proxy_*.cfg`) so a depleted/expired pay-per-GB port doesn't come back up
// as a free proxy after a reboot; enablePort must promote it back.
//
// Plain Node assertions (no framework). Run with:
//   node node_runtime/node_agent/accounting.lifecycle.test.js
// Cross-platform: exercises the pure-fs cfg lifecycle, not the Linux-only
// pgrep/SIGTERM path (which needs a real 3proxy process).

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// accounting.js reads NODE_AGENT_PROXY_ROOT ONCE at module load — set it first.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "netrun-acct-"));
process.env.NODE_AGENT_PROXY_ROOT = ROOT;
const acct = require("./accounting.js");

fs.mkdirSync(path.join(ROOT, "3proxy"), { recursive: true });

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed += 1;
}

const port = 40050;
const cfg = acct.configPathForPort(port);
const disabled = acct.disabledConfigPathForPort(port);

// ── the disabled name is invisible to the restore glob ──
ok(disabled.endsWith("3proxy_40050.cfg.disabled"), "disabled path uses .cfg.disabled suffix");
ok(!/3proxy_\d+\.cfg$/.test(disabled), "disabled name is NOT matched by the 3proxy_*.cfg restore glob");

// ── _demoteCfg: live cfg → .cfg.disabled ──
fs.writeFileSync(cfg, "users x\n");
ok(acct._demoteCfg(cfg, port) === true, "_demoteCfg renamed the live cfg");
ok(!fs.existsSync(cfg), "live cfg is gone after demote (reboot restore will skip it)");
ok(fs.existsSync(disabled), ".cfg.disabled is present after demote");
// Idempotent: demoting a now-missing cfg is a no-op (ENOENT swallowed, no throw).
ok(acct._demoteCfg(cfg, port) === false, "_demoteCfg on a missing cfg returns false without throwing");

// ── enablePort promotes .cfg.disabled → live BEFORE attempting to spawn ──
// There is no real 3proxy binary / process in the temp root, so enablePort
// raises (pgrep_failed on win32 / 3proxy_binary_missing on Linux) — but the
// promote runs first, so assert the cfg was restored regardless of the error.
(async () => {
  let threw = null;
  try {
    await acct.enablePort(port);
  } catch (e) {
    threw = e;
  }
  ok(threw !== null, "enablePort raised (cannot spawn a real 3proxy in the test env)");
  ok(fs.existsSync(cfg), "enablePort promoted .cfg.disabled back to the live cfg");
  ok(!fs.existsSync(disabled), ".cfg.disabled was consumed by the promote");

  console.log(`accounting.lifecycle.test.js: ${passed} assertions passed`);
})();
