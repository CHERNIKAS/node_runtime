"use strict";

// Unit test for the per-port disable "generation" guard that prevents a
// deferred force-kill from killing a freshly RE-ENABLED proxy when an
// enablePort lands inside the SIGKILL grace window (the critical race the
// adversarial review caught).
//
// Pure logic — no pgrep / process.kill — so it runs anywhere (incl. dev boxes
// without the Linux proxy stack).
//
// Run with: node node_runtime/node_agent/accounting.disable_gen.test.js
// Exits non-zero on the first failed assertion.

const assert = require("assert");
const path = require("path");

const accounting = require(path.resolve(__dirname, "accounting.js"));

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed += 1;
}

// 1. Tokens are monotonically increasing per port.
const g1 = accounting._bumpDisableGen(50000);
const g2 = accounting._bumpDisableGen(50000);
ok(g2 > g1, "gen increases on repeated bump for the same port");

// 2. A captured token goes stale once the port is bumped again — this is
//    exactly the check the deferred SIGKILL performs ("am I still current?").
const captured = accounting._bumpDisableGen(50001);
ok(accounting._disableGen.get(50001) === captured, "captured == current right after arm");
accounting._bumpDisableGen(50001); // simulate enablePort / a newer disable
ok(
  accounting._disableGen.get(50001) !== captured,
  "captured token is STALE after a subsequent bump → force-kill must abort"
);

// 3. Ports are independent — bumping one doesn't invalidate another's token.
const a = accounting._bumpDisableGen(50002);
accounting._bumpDisableGen(50003);
ok(accounting._disableGen.get(50002) === a, "a different port's token is unaffected");

// 4. Grace constant is a sane non-negative number (default 2000 unless overridden).
ok(
  Number.isFinite(accounting.DISABLE_GRACE_MS) && accounting.DISABLE_GRACE_MS >= 0,
  "DISABLE_GRACE_MS is a finite, non-negative number"
);

console.log(`accounting.disable_gen: ${passed} assertions passed`);
