"use strict";

// Wave NODE-GENLOCK-HARDENING — unit tests for computeProxyReadiness, the pure
// /health readiness verdict. It exists so the orchestrator can tell "agent up
// but 3proxy not listening yet" (a freshly-booted node — must NOT mass-
// invalidate proxies) from "agent up and 3proxy actually serving".
//
// Run with: node --test node_runtime/node_agent/server.proxy_ready.test.js

const assert = require("assert");
const path = require("path");

const { computeProxyReadiness } = require(path.resolve(__dirname, "server.js"));

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed += 1;
}
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
  passed += 1;
}

const inst = (startPort) => ({ pid: 1000 + startPort, startPort, cfgPath: `3proxy_${startPort}.cfg` });

// (1) THE BOOT WINDOW: agent up, no 3proxy process yet → NOT ready.
{
  const r = computeProxyReadiness([], new Set(), true);
  ok(r.ready === false, "1a: zero instances → not ready");
  eq(r.instanceCount, 0, "1b: instanceCount 0");
  eq(r.listeningPortCount, 0, "1c: no listening ports");
}

// (2) process running but its port NOT yet bound → NOT ready (the exact window
//     that triggers spurious mass-invalidation if /health only checked liveness).
{
  const r = computeProxyReadiness([inst(20000)], new Set([22, 8085]), true);
  ok(r.ready === false, "2a: instance present but port not listening → not ready");
  eq(r.instancesWithKnownPort, 1, "2b: one known-port instance");
  eq(r.instancesListening, 0, "2c: zero listening");
}

// (3) instance running AND its port listening → READY.
{
  const r = computeProxyReadiness([inst(20000)], new Set([20000, 22]), true);
  ok(r.ready === true, "3a: instance + matching listener → ready");
  eq(r.instancesListening, 1, "3b: one listening");
}

// (4) multiple instances, all listening → READY.
{
  const ports = new Set([20000, 20001, 20002]);
  const r = computeProxyReadiness([inst(20000), inst(20001), inst(20002)], ports, true);
  ok(r.ready === true, "4a: all instances listening → ready");
  eq(r.instancesListening, 3, "4b: three listening");
}

// (5) multiple instances, one not yet listening → NOT ready (partial boot).
{
  const ports = new Set([20000, 20001]); // 20002 missing
  const r = computeProxyReadiness([inst(20000), inst(20001), inst(20002)], ports, true);
  ok(r.ready === false, "5a: partial listeners → not ready");
  eq(r.instancesListening, 2, "5b: two of three listening");
  eq(r.instancesWithKnownPort, 3, "5c: three known-port instances");
}

// (6) ss probe FAILED → cannot assert readiness → NOT ready, probeOk=false.
{
  const r = computeProxyReadiness([inst(20000)], new Set(), false);
  ok(r.ready === false, "6a: failed port probe → not ready");
  ok(r.probeOk === false, "6b: probeOk reflects the failure (inconclusive)");
}

// (7) accepts an array of ports too (not only a Set).
{
  const r = computeProxyReadiness([inst(20000)], [20000], true);
  ok(r.ready === true, "7: array ports accepted");
}

// (8) instances with unparseable startPort (0): fall back to "any proxy port
//     listening" weak signal so a node isn't wrongly judged unready.
{
  const r = computeProxyReadiness([{ pid: 5, startPort: 0 }], new Set([20000]), true);
  ok(r.ready === true, "8a: unknown-port instance + some listener → ready (fallback)");
  eq(r.instancesWithKnownPort, 0, "8b: no known-port instances counted");
}

// (9) unknown-port instance and NOTHING listening → not ready.
{
  const r = computeProxyReadiness([{ pid: 5, startPort: 0 }], new Set(), true);
  ok(r.ready === false, "9: unknown-port instance + no listeners → not ready");
}

console.log(`server.proxy_ready.test.js — all ${passed} assertions passed`);
