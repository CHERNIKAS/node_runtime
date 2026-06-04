"use strict";

// Wave HTTP.A — unit tests for the dual-proxy node-agent changes.
// Plain Node assertions (no framework in this repo). Run with:
//   node node_runtime/node_agent/server.http_a.test.js
// Exits non-zero on the first failed assertion.

const assert = require("assert");
const path = require("path");
const { parseProxyLine, collectJobParams, buildGeneratorArgs } = require("./server.js");

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed += 1;
}

// ── parseProxyLine: protocol tagging + scheme handling ───────────

// Legacy "ipv4:port:login:pass" → socks5 (backward-compat, unchanged).
const legacy = parseProxyLine("1.2.3.4:20001:user:pass");
ok(legacy && legacy.protocol === "socks5", "legacy line → protocol socks5");
ok(legacy.port === 20001 && legacy.host === "1.2.3.4", "legacy host/port parsed");
ok(legacy.raw_line === "Socks5://user:pass@1.2.3.4:20001", "legacy raw_line is Socks5://");

// Explicit socks5:// URI → socks5, raw_line preserved.
const s = parseProxyLine("socks5://user:pass@1.2.3.4:20001");
ok(s && s.protocol === "socks5" && s.port === 20001, "socks5:// → protocol socks5");
ok(s.raw_line === "socks5://user:pass@1.2.3.4:20001", "socks5:// raw_line preserved");

// Wave HTTP.A — http:// URI → protocol http (the dual second line).
const h = parseProxyLine("http://user:pass@1.2.3.4:10001");
ok(h && h.protocol === "http", "http:// → protocol http");
ok(h.port === 10001 && h.host === "1.2.3.4", "http:// host/port parsed");
ok(h.raw_line === "http://user:pass@1.2.3.4:10001", "http:// raw_line preserved");

// Comments / blanks → null (unchanged).
ok(parseProxyLine("# comment") === null, "comment → null");
ok(parseProxyLine("") === null, "blank → null");

// ── collectJobParams: proxies type (default socks5) ──────────────

ok(collectJobParams({}, []).proxiesType === "socks5", "no protocol → socks5 (backward-compat)");
ok(collectJobParams({ protocol: "dual" }, []).proxiesType === "dual", "protocol=dual → dual");
ok(collectJobParams({ proxies_type: "http" }, []).proxiesType === "http", "proxies_type=http → http");
ok(collectJobParams({ proxiesType: "DUAL" }, []).proxiesType === "dual", "case-insensitive dual");
ok(collectJobParams({ protocol: "garbage" }, []).proxiesType === "socks5", "junk protocol → socks5");
ok(
  collectJobParams({}, ["--proxies-type", "dual"]).proxiesType === "dual",
  "rawArgs --proxies-type dual → dual"
);

// ── buildGeneratorArgs: threads proxiesType into --proxies-type ──

const SCRIPT = path.resolve(__dirname, "..", "generator", "proxyyy_automated.sh");

function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

(async () => {
  const dualArgs = await buildGeneratorArgs({
    rawArgs: [],
    scriptPath: SCRIPT,
    startPort: 20000,
    proxyCount: 5,
    ipv6Policy: "ipv6_only",
    networkProfile: "high_compatibility",
    proxiesType: "dual",
    proxiesListPath: "/tmp/list",
    mapCsvPath: "/tmp/map.csv",
  });
  ok(flagValue(dualArgs, "--proxies-type") === "dual", "dual job → --proxies-type dual");

  const defaultArgs = await buildGeneratorArgs({
    rawArgs: [],
    scriptPath: SCRIPT,
    startPort: 30000,
    proxyCount: 5,
    ipv6Policy: "ipv6_only",
    networkProfile: "high_compatibility",
    proxiesType: undefined,
    proxiesListPath: "/tmp/list",
    mapCsvPath: "/tmp/map.csv",
  });
  ok(
    flagValue(defaultArgs, "--proxies-type") === "socks5",
    "no proxiesType → --proxies-type socks5 (backward-compat)"
  );

  console.log(`server.http_a.test.js — all ${passed} assertions passed`);
})().catch((err) => {
  console.error("server.http_a.test.js FAILED:", err && err.message);
  process.exit(1);
});
