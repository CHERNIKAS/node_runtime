"use strict";

// Wave PERGB-METER-CACHE — unit tests for the per-cycle counter-dump cache in
// getCountersForPorts. Use a tiny cache-gap so cycle boundaries are fast to
// exercise. MUST be set BEFORE requiring the module (consts read env at load).
process.env.NODE_AGENT_COUNTERS_CACHE_GAP_MS = "50";
process.env.NODE_AGENT_COUNTERS_CACHE_MAX_MS = "5000";

const test = require("node:test");
const assert = require("node:assert");
const accounting = require("./accounting");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Canned `nft -j list counters` items: ports 30000/30001/30002.
function cannedItems() {
  return [
    { counter: { family: "inet", table: "proxy_accounting", name: "proxy_30000_in", bytes: 100 } },
    { counter: { family: "inet", table: "proxy_accounting", name: "proxy_30000_out", bytes: 200 } },
    { counter: { family: "inet", table: "proxy_accounting", name: "proxy_30001_in", bytes: 5 } },
    { counter: { family: "inet", table: "proxy_accounting", name: "proxy_30001_out", bytes: 6 } },
    { counter: { family: "inet", table: "proxy_accounting", name: "proxy_30002_in", bytes: 9 } },
    // noise that must be ignored (wrong table / unparseable name / retired in6)
    { counter: { family: "inet", table: "other", name: "proxy_30000_in", bytes: 999 } },
    { counter: { family: "inet", table: "proxy_accounting", name: "garbage", bytes: 7 } },
    { counter: { family: "inet", table: "proxy_accounting", name: "proxy_30000_in6", bytes: 50 } },
  ];
}

test("filters to requested ports with correct cumulative bytes; in6 retired", async () => {
  accounting._resetCountersCache();
  accounting._setCounterItemsFetcher(async () => cannedItems());
  const out = await accounting.getCountersForPorts([30000, 30001]);
  assert.deepStrictEqual(out, {
    "30000": { bytes_in: 100, bytes_out: 200 }, // in6 (50) NOT summed
    "30001": { bytes_in: 5, bytes_out: 6 },
  });
  assert.ok(!("30002" in out), "unrequested port excluded");
  accounting._setCounterItemsFetcher(null);
});

test("all chunks within one cycle reuse a single dump (no storm)", async () => {
  accounting._resetCountersCache();
  let dumps = 0;
  accounting._setCounterItemsFetcher(async () => { dumps++; return cannedItems(); });
  // simulate ~50 back-to-back chunk requests of one poll cycle
  for (let i = 0; i < 50; i++) {
    const r = await accounting.getCountersForPorts([30000]);
    assert.strictEqual(r["30000"].bytes_out, 200);
  }
  assert.strictEqual(dumps, 1, "exactly ONE nft dump for the whole cycle");
  accounting._setCounterItemsFetcher(null);
});

test("concurrent chunks coalesce onto one in-flight dump", async () => {
  accounting._resetCountersCache();
  let dumps = 0;
  accounting._setCounterItemsFetcher(async () => { dumps++; await sleep(25); return cannedItems(); });
  const results = await Promise.all(
    Array.from({ length: 30 }, () => accounting.getCountersForPorts([30001]))
  );
  assert.strictEqual(dumps, 1, "30 concurrent callers share ONE dump");
  for (const r of results) assert.strictEqual(r["30001"].bytes_in, 5);
  accounting._setCounterItemsFetcher(null);
});

test("a gap longer than GAP_MS starts a new cycle (fresh dump)", async () => {
  accounting._resetCountersCache();
  let dumps = 0;
  accounting._setCounterItemsFetcher(async () => { dumps++; return cannedItems(); });
  await accounting.getCountersForPorts([30000]); // cycle 1 -> dump
  await sleep(80);                                // gap > 50ms -> next cycle
  await accounting.getCountersForPorts([30000]); // cycle 2 -> fresh dump
  assert.strictEqual(dumps, 2, "each poll cycle re-dumps fresh");
  accounting._setCounterItemsFetcher(null);
});

test("fresh dump reflects NEW counter values on the next cycle (delta-safe)", async () => {
  accounting._resetCountersCache();
  let n = 0;
  accounting._setCounterItemsFetcher(async () => {
    n++;
    const v = n === 1 ? 100 : 350; // counter grew between cycles
    return [{ counter: { family: "inet", table: "proxy_accounting", name: "proxy_30000_out", bytes: v } }];
  });
  const c1 = await accounting.getCountersForPorts([30000]);
  await sleep(80);
  const c2 = await accounting.getCountersForPorts([30000]);
  assert.strictEqual(c1["30000"].bytes_out, 100);
  assert.strictEqual(c2["30000"].bytes_out, 350, "cycle 2 sees the grown counter, not a stale cache");
  accounting._setCounterItemsFetcher(null);
});

test("empty / no-ports request short-circuits without a dump", async () => {
  accounting._resetCountersCache();
  let dumps = 0;
  accounting._setCounterItemsFetcher(async () => { dumps++; return cannedItems(); });
  const out = await accounting.getCountersForPorts([]);
  assert.deepStrictEqual(out, {});
  assert.strictEqual(dumps, 0, "no dump when nothing requested");
  accounting._setCounterItemsFetcher(null);
});
