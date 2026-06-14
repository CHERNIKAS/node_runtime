"use strict";

// Wave EGRESS-TOGGLE — unit test for the pure 3proxy egress-flag rewrite.
//
// Covers both directions (dualstack ⇄ ipv6_only), idempotency, the critical
// '-6' vs '-64' partial-match guard, multi-line configs (dual http+socks pairs,
// several IPv6 addresses), and that non-startup lines are left untouched.
//
// Pure string logic — no fs / pgrep / spawn — so it runs anywhere.
// Run with: node node_runtime/node_agent/egress_mode.rewrite.test.js
// Exits non-zero on the first failed assertion.

const assert = require("assert");
const path = require("path");

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

// A realistic config fragment as emitted by soft/generator (immutable header +
// auth + access rules that must NOT be rewritten, then the per-port startup
// lines that MUST be rewritten).
const DUALSTACK_CFG = [
  "nscache 65536",
  "nscache6 65536",
  "timeouts 1 5 30 60 180 1800 15 60",
  "auth strong",
  "users alice:CL:secret",
  "allow * * example.com",
  "deny *",
  "socks -64 -a -p30000 -i203.0.113.5 -e2001:db8::1",
  "proxy -64 -n -a -p20000 -i203.0.113.5 -e2001:db8::1",
  "socks -64 -a -p30001 -i203.0.113.5 -e2001:db8::2",
  "proxy -64 -n -a -p20001 -i203.0.113.5 -e2001:db8::2",
].join("\n");

const IPV6ONLY_CFG = [
  "nscache 65536",
  "nscache6 65536",
  "timeouts 1 5 30 60 180 1800 15 60",
  "auth strong",
  "users alice:CL:secret",
  "allow * * example.com",
  "deny *",
  "socks -6 -a -p30000 -i203.0.113.5 -e2001:db8::1",
  "proxy -6 -n -a -p20000 -i203.0.113.5 -e2001:db8::1",
  "socks -6 -a -p30001 -i203.0.113.5 -e2001:db8::2",
  "proxy -6 -n -a -p20001 -i203.0.113.5 -e2001:db8::2",
].join("\n");

// ── 1. dualstack → ipv6_only ─────────────────────────────────────
{
  const { text, changed } = egress.rewriteConfigText(DUALSTACK_CFG, "ipv6_only");
  ok(changed, "dualstack→ipv6_only reports changed");
  eq(text, IPV6ONLY_CFG, "dualstack→ipv6_only produces exact ipv6_only config");
}

// ── 2. ipv6_only → dualstack (reverse) ───────────────────────────
{
  const { text, changed } = egress.rewriteConfigText(IPV6ONLY_CFG, "dualstack");
  ok(changed, "ipv6_only→dualstack reports changed");
  eq(text, DUALSTACK_CFG, "ipv6_only→dualstack produces exact dualstack config");
}

// ── 3. idempotent: re-applying the SAME mode is a byte-for-byte no-op ─
{
  const r1 = egress.rewriteConfigText(IPV6ONLY_CFG, "ipv6_only");
  eq(r1.changed, false, "ipv6_only on already-ipv6_only config → changed=false");
  eq(r1.text, IPV6ONLY_CFG, "ipv6_only idempotent → identical text");

  const r2 = egress.rewriteConfigText(DUALSTACK_CFG, "dualstack");
  eq(r2.changed, false, "dualstack on already-dualstack config → changed=false");
  eq(r2.text, DUALSTACK_CFG, "dualstack idempotent → identical text");
}

// ── 4. round-trip stability (apply, reverse, re-apply) ───────────
{
  const toV6 = egress.rewriteConfigText(DUALSTACK_CFG, "ipv6_only").text;
  const backToDual = egress.rewriteConfigText(toV6, "dualstack").text;
  eq(backToDual, DUALSTACK_CFG, "dualstack → ipv6_only → dualstack round-trips to original");
}

// ── 5. CRITICAL: '-6' must NOT partially match inside '-64' ──────
// When target is ipv6_only and the line is already '-64', it must become '-6'
// (a real change), NOT leave a mangled '-64'/'-44'. And when target is dualstack
// the '-64' lines must be recognised as already-correct (no double-rewrite to
// '-644' or similar).
{
  const line64 = "socks -64 -a -p30000 -i1.2.3.4 -e2001:db8::1";
  const v6 = egress.rewriteConfigText(line64, "ipv6_only");
  eq(v6.text, "socks -6 -a -p30000 -i1.2.3.4 -e2001:db8::1", "'-64' → '-6' cleanly (no -44/-664 corruption)");

  const dual = egress.rewriteConfigText(line64, "dualstack");
  eq(dual.changed, false, "'-64' under dualstack target → recognised as correct, no rewrite");
  eq(dual.text, line64, "'-64' under dualstack target → unchanged");
}

// ── 6. non-startup lines (incl. ones containing -6/-64 substrings) untouched ─
{
  const tricky = [
    "users bob:CL:p-64word",          // a password that contains -64
    "allow * * host-6.example.com",   // a hostname containing -6
    "timeouts 1 5 30 60 180 1800 15 60",
    "socks -64 -a -p30000 -i1.2.3.4 -e2001:db8::1",
  ].join("\n");
  const expected = [
    "users bob:CL:p-64word",
    "allow * * host-6.example.com",
    "timeouts 1 5 30 60 180 1800 15 60",
    "socks -6 -a -p30000 -i1.2.3.4 -e2001:db8::1",
  ].join("\n");
  const { text, changed } = egress.rewriteConfigText(tricky, "ipv6_only");
  ok(changed, "tricky config: the real startup line changed");
  eq(text, expected, "tricky config: only the leading socks/proxy flag rewritten, non-startup lines verbatim");
}

// ── 7. leading whitespace / indented startup lines preserved ─────
{
  const indented = "   socks -64 -a -p30000 -i1.2.3.4 -e2001:db8::1";
  const r = egress.rewriteConfigText(indented, "ipv6_only");
  eq(r.text, "   socks -6 -a -p30000 -i1.2.3.4 -e2001:db8::1", "leading indentation preserved on rewrite");
}

// ── 8. trailing-newline preservation ─────────────────────────────
{
  const withTrailing = "socks -64 -a -p1 -i1.2.3.4 -e::1\n";
  const r = egress.rewriteConfigText(withTrailing, "ipv6_only");
  eq(r.text, "socks -6 -a -p1 -i1.2.3.4 -e::1\n", "trailing newline preserved (not added/dropped)");
}

// ── 9. flagForMode / VALID_MODES sanity ──────────────────────────
{
  eq(egress.flagForMode("dualstack"), "-64", "flagForMode dualstack = -64");
  eq(egress.flagForMode("ipv6_only"), "-6", "flagForMode ipv6_only = -6");
  ok(egress.VALID_MODES.has("dualstack") && egress.VALID_MODES.has("ipv6_only"), "VALID_MODES has both modes");
  let threw = false;
  try { egress.flagForMode("garbage"); } catch (e) { threw = e && e.code === "EGRESS_MODE_ERROR"; }
  ok(threw, "flagForMode('garbage') throws EgressModeError");
}

console.log(`egress_mode.rewrite.test.js — all ${passed} assertions passed`);
