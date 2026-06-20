#!/usr/bin/env bash
# Wave HTTP.A — tests for the generator dual-proxy mode. Extracts the
# actual write_* functions from proxyyy_automated.sh and runs them with
# controlled globals (no 3proxy / network needed). Run with:
#   bash node_runtime/soft/generator/test_http_a_dual.sh
set -euo pipefail

GEN="$(dirname "$0")/proxyyy_automated.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $1"; exit 1; }
log_err() { :; }   # stub used inside the extracted functions

# Pull the two write functions verbatim from the script and eval them.
eval "$(sed -n '/^function write_backconnect_proxies_to_file()/,/^}/p' "$GEN")"
eval "$(sed -n '/^function write_port_ipv6_map_file()/,/^}/p' "$GEN")"

# Shared globals the functions reference.
backconnect_ipv4="1.2.3.4"
credentials=":user:pass"
use_random_auth=false
script_log_file="$TMP/log"
instance_id="20000"
random_users_list_file="$TMP/users"   # unused (use_random_auth=false)

# ── 1. dual report list: two URI lines per IP, paired ports ──────
backconnect_proxies_file="$TMP/dual.list"
start_port=20000; last_port=20002; proxies_type="dual"
write_backconnect_proxies_to_file
socks_n=$(grep -c '^socks5://' "$backconnect_proxies_file" || true)
http_n=$(grep -c '^http://' "$backconnect_proxies_file" || true)
[ "$socks_n" = "3" ] || fail "dual: expected 3 socks5:// lines, got $socks_n"
[ "$http_n" = "3" ] || fail "dual: expected 3 http:// lines, got $http_n"
grep -qx "socks5://user:pass@1.2.3.4:20001" "$backconnect_proxies_file" || fail "dual: missing socks 20001"
grep -qx "http://user:pass@1.2.3.4:10001" "$backconnect_proxies_file" || fail "dual: missing paired http 10001 (socks 20001 - 10000)"
echo "ok: dual report list — both directives, paired ports (http = socks - 10000)"

# ── 2. socks5 single mode unchanged (legacy ipv4:port:login:pass) ─
backconnect_proxies_file="$TMP/socks.list"
start_port=20000; last_port=20001; proxies_type="socks5"
write_backconnect_proxies_to_file
grep -qx "1.2.3.4:20000:user:pass" "$backconnect_proxies_file" || fail "socks5: legacy line format changed"
! grep -q '://' "$backconnect_proxies_file" || fail "socks5: unexpected URI scheme in legacy mode"
echo "ok: socks5 single mode — legacy format unchanged (backward-compat)"

# ── 3. dual port_ipv6_map: both ports → same IPv6 ────────────────
printf '%s\n%s\n' "2001:db8::1" "2001:db8::2" > "$TMP/ipv6.list"
random_ipv6_list_file="$TMP/ipv6.list"
port_ipv6_map_file="$TMP/dual.csv"
start_port=20000; last_port=20001; proxies_type="dual"
write_port_ipv6_map_file
grep -qx "20000,2001:db8::1,1.2.3.4,20000" "$port_ipv6_map_file" || fail "dual map: socks 20000→ip1 missing"
grep -qx "10000,2001:db8::1,1.2.3.4,20000" "$port_ipv6_map_file" || fail "dual map: http 10000→ip1 missing (paired)"
grep -qx "20001,2001:db8::2,1.2.3.4,20000" "$port_ipv6_map_file" || fail "dual map: socks 20001→ip2 missing"
grep -qx "10001,2001:db8::2,1.2.3.4,20000" "$port_ipv6_map_file" || fail "dual map: http 10001→ip2 missing (paired)"
echo "ok: dual port_ipv6_map — both ports persisted to same IPv6 (reboot restores both)"

# ── 4. socks5 map unchanged (one row per IP) ─────────────────────
port_ipv6_map_file="$TMP/socks.csv"
start_port=20000; last_port=20001; proxies_type="socks5"
write_port_ipv6_map_file
rows=$(grep -c '^[12]' "$port_ipv6_map_file" || true)
[ "$rows" = "2" ] || fail "socks5 map: expected 2 data rows, got $rows"
echo "ok: socks5 map — one row per IP unchanged (backward-compat)"

# ── 5. startup-loop emits a paired http 3proxy directive for dual ─
grep -q 'if \[ "\$proxies_type" = "dual" \]' "$GEN" || fail "startup loop: dual conditional missing"
grep -q 'proxy \$mode_flag -n -a -p\\\$((port - 10000))' "$GEN" || fail "startup loop: dual http directive missing"
echo "ok: startup-script loop — dual emits paired http 3proxy directive"

echo "test_http_a_dual.sh — all generator dual checks passed"
