"use strict";

// Wave KILL-ON-REBIND — unit tests for the pure pid-selection core
// selectPidsToKill(ssText, low, high). The kill side-effects are kept thin
// around this function; here we verify only the selection logic.
//
// Run with: node node_runtime/node_agent/server.kill_on_rebind.test.js
// Exits non-zero on the first failed assertion.

const assert = require("assert");
const path = require("path");

const { selectPidsToKill, selectGenerationRebindPids } = require(path.resolve(__dirname, "server.js"));

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed += 1;
}
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
  passed += 1;
}

// Representative `ss -tlnpH` rows (header already absent in -H form).
function row(addr, pid) {
  // State Recv-Q Send-Q Local-Address:Port Peer-Address:Port Process
  return `LISTEN 0 4096 ${addr} 0.0.0.0:* users:(("3proxy",pid=${pid},fd=5))`;
}

// (a) overlapping socks listener IS selected.
{
  const text = [row("0.0.0.0:1080", 4242)].join("\n");
  eq(selectPidsToKill(text, 1080, 1083), [4242], "a: overlapping socks pid selected");
}

// (b) non-overlapping listener NOT selected.
{
  const text = [row("0.0.0.0:1090", 5555)].join("\n");
  eq(selectPidsToKill(text, 1080, 1083), [], "b: non-overlapping pid not selected");
}

// (c) http-range listener (start-10000) IS selected when the range covers it.
// New start=11080 → http listener at 1080. Target span covers [1080..11083].
{
  const text = [row("[::]:1080", 7001), row("0.0.0.0:11080", 7002)].join("\n");
  eq(
    selectPidsToKill(text, 1080, 11083),
    [7001, 7002],
    "c: http-range (port-10000) listener selected alongside socks"
  );
}

// (d) malformed / junk lines are ignored, valid ones still selected.
{
  const text = [
    "garbage line with no colon or pid",
    "LISTEN 0 4096 weird:notaport users:((\"x\",pid=999,fd=1))",
    "ESTAB 0 0 0.0.0.0:1081 0.0.0.0:* users:((\"3proxy\",pid=111,fd=2))", // not LISTEN
    "LISTEN 0 4096 0.0.0.0:1082 0.0.0.0:* nopidhere", // no pid=
    row("0.0.0.0:1083", 222), // the only valid+overlapping row
    "",
  ].join("\n");
  eq(selectPidsToKill(text, 1080, 1083), [222], "d: malformed lines ignored, valid selected");
}

// (e) empty / failed ss → empty.
{
  eq(selectPidsToKill("", 1080, 1083), [], "e1: empty ss text → empty");
  eq(selectPidsToKill(undefined, 1080, 1083), [], "e2: undefined ss text → empty");
  eq(selectPidsToKill(null, 1080, 1083), [], "e3: null ss text → empty");
}

// Extra guards: bad range → empty; one pid on multiple ports deduped.
{
  eq(selectPidsToKill(row("0.0.0.0:1080", 1), 1083, 1080), [], "f: low>high → empty");
  const dup = [row("0.0.0.0:1080", 42), row("0.0.0.0:1081", 42)].join("\n");
  eq(selectPidsToKill(dup, 1080, 1083), [42], "g: same pid on multiple ports deduped");
  const two = [row("0.0.0.0:1083", 9), row("0.0.0.0:1080", 3)].join("\n");
  eq(selectPidsToKill(two, 1080, 1083), [3, 9], "h: result sorted ascending by pid");
}

// === selectGenerationRebindPids — the two-range, gap-safe generation selector ===
// REGRESSION: a single [min,max] span used to kill prior batches sitting in the
// gap between the new generation's http range and its socks range. These tests
// pin that the gap is never matched while both real ranges still are.

// (i) THE BUG: new generation socks=[32800..32999], http=[22800..22999].
// A prior valid batch listens on socks 32000 (pid 100) + its http 22000 (101) —
// BOTH live in the gap (22999 < port < 32800) and MUST survive.
{
  const text = [
    row("0.0.0.0:32000", 100), // prior batch socks — in the gap
    row("0.0.0.0:22000", 101), // prior batch http  — in the gap
    row("0.0.0.0:32800", 200), // new batch socks   — MUST be killed
    row("0.0.0.0:22800", 201), // new batch http    — MUST be killed
  ].join("\n");
  eq(
    selectGenerationRebindPids(text, 32800, 200),
    [200, 201],
    "i: gap-resident prior batch (32000/22000) survives; only new socks+http ranges killed"
  );
}

// (ii) the OLD wide span [22800..32999] would have matched the gap listener —
// prove selectPidsToKill (single span) still does, so we know the fix lives in
// the caller, not the pure core.
{
  const text = [row("0.0.0.0:32000", 100)].join("\n");
  eq(selectPidsToKill(text, 22800, 32999), [100], "ii: wide span still matches gap (old behavior pinned)");
  eq(selectGenerationRebindPids(text, 32800, 200), [], "ii: gap-safe selector does NOT match the gap listener");
}

// (iii) boundaries of both ranges are inclusive; just-outside is excluded.
{
  const text = [
    row("0.0.0.0:32999", 1), // socksHigh — in
    row("0.0.0.0:33000", 2), // socksHigh+1 — out
    row("0.0.0.0:22999", 3), // httpHigh — in
    row("0.0.0.0:22799", 4), // httpLow-1 — out
  ].join("\n");
  eq(selectGenerationRebindPids(text, 32800, 200), [1, 3], "iii: range edges inclusive, just-outside excluded");
}

// (iv) low-start generation where http range underflows (httpHigh < httpLow):
// only the socks range is matched, no crash.
{
  const text = [row("0.0.0.0:1080", 9), row("0.0.0.0:5000", 8)].join("\n");
  eq(selectGenerationRebindPids(text, 1080, 4), [9], "iv: http range skipped when it underflows; socks still matched");
}

// (v) zero/invalid args → empty (mirrors killOverlappingListeners guard).
{
  eq(selectGenerationRebindPids("anything", 0, 200), [], "v1: zero start → empty");
  eq(selectGenerationRebindPids("anything", 32800, 0), [], "v2: zero count → empty");
}

ok(true, "module exported selectPidsToKill");
ok(typeof selectGenerationRebindPids === "function", "module exported selectGenerationRebindPids");
console.log(`server.kill_on_rebind.test.js — all ${passed} assertions passed`);
