#!/usr/bin/env bash
# NETRUN — in-place DNS migration for EXISTING 3proxy instances.
#
# Rewrites the `nserver` lines in every /opt/netrun/proxyserver/3proxy/3proxy_*.cfg
# to use the bundled per-country geo-local resolvers from dns/seed.json
# (built in Phase 2a). Does NOT regenerate the configs — ports, IPs, creds,
# users, auth lines are preserved verbatim. Then SIGTERMs all 3proxy
# instances and re-spawns them via the existing restore script.
#
# Idempotent: a second run is a no-op (current nserver == target nserver).
#
# ── BLIP WARNING ─────────────────────────────────────────────────────────────
#  Restart causes a brief outage per port (~5–15 s during pkill → respawn).
#  Run during low-traffic window. Clients with active TCP sessions will see
#  their connections drop and reconnect; new connect attempts during the gap
#  receive ECONNREFUSED until the per-port 3proxy daemon comes back.
# ─────────────────────────────────────────────────────────────────────────────
#
# Usage:
#   bash scripts/migrate_dns_inplace.sh [--dry-run] [--country CC]
#                                       [--cfg-dir PATH] [--no-restart]
#
# Options:
#   --dry-run     show planned changes, don't touch any cfg or kill anything
#   --country CC  override country detection (e.g. US, DE — uppercase 2-letter)
#   --cfg-dir     override /opt/netrun/proxyserver/3proxy
#   --no-restart  rewrite cfgs but do NOT pkill+restore (manual restart later)
#
# Exit codes:
#   0 — success (including no-op)
#   1 — usage / fatal env error
#   2 — seed missing or jq missing

set -u

NETRUN_HOME="${NETRUN_HOME:-/opt/netrun}"
CFG_DIR="${NETRUN_HOME}/proxyserver/3proxy"
PROXY_BIN="${NETRUN_HOME}/proxyserver/3proxy/bin/3proxy"
RESTORE_SCRIPT="${NETRUN_HOME}/scripts/restore-3proxy.sh"
SELECT_DNS="${NETRUN_HOME}/dns/select_dns.sh"

dry_run=0
country_override=""
no_restart=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    --country) country_override="$2"; shift 2 ;;
    --cfg-dir) CFG_DIR="$2"; shift 2 ;;
    --no-restart) no_restart=1; shift ;;
    -h|--help) sed -n '1,40p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

log()  { printf '[migrate-dns] %s\n' "$*"; }
warn() { printf '[migrate-dns] WARN: %s\n' "$*" >&2; }
die()  { printf '[migrate-dns] ERROR: %s\n' "$*" >&2; exit 1; }

# ── Preflight ────────────────────────────────────────────────────────────────
[ -d "$CFG_DIR" ] || die "cfg dir not found: $CFG_DIR"
[ -f "$SELECT_DNS" ] || { warn "select_dns.sh missing: $SELECT_DNS"; exit 2; }
command -v jq >/dev/null || { warn "jq not installed (apt-get install -y jq)"; exit 2; }

# shellcheck disable=SC1090
source "$SELECT_DNS"

# Verify the function is available.
declare -F dns_select_pair >/dev/null || die "dns_select_pair() not defined after sourcing $SELECT_DNS"

seed_path=$(locate_dns_seed || true)
if [ -z "$seed_path" ]; then
  warn "dns/seed.json not found (looked under \$NETRUN_HOME/dns, /opt/netrun/dns); will use hardcoded fallback for ALL configs"
fi

# ── Country detection ───────────────────────────────────────────────────────
detect_node_country() {
  local pub_ip="" cc=""
  for url in https://ipv4.icanhazip.com https://api.ipify.org https://ifconfig.me/ip; do
    pub_ip=$(curl -4 -sS --max-time 5 "$url" 2>/dev/null | tr -d '\r\n[:space:]')
    if [[ "$pub_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then break; fi
    pub_ip=""
  done
  if [ -z "$pub_ip" ]; then return 1; fi
  for url in "https://ipapi.co/${pub_ip}/country/" "https://ipinfo.io/${pub_ip}/country"; do
    cc=$(curl -4 -sS --max-time 8 "$url" 2>/dev/null | tr -d '\r\n[:space:]')
    if [[ "$cc" =~ ^[A-Za-z]{2}$ ]]; then echo "${cc^^}"; return 0; fi
  done
  cc=$(curl -4 -sS --max-time 8 "https://ipwho.is/${pub_ip}" 2>/dev/null \
       | grep -m1 -oP '"country_code":"\K[A-Z]{2}' || true)
  if [[ "$cc" =~ ^[A-Z]{2}$ ]]; then echo "$cc"; return 0; fi
  return 1
}

if [ -n "$country_override" ]; then
  CC=$(echo "$country_override" | tr '[:lower:]' '[:upper:]')
  log "country: $CC (override)"
else
  CC=$(detect_node_country || true)
  if [[ ! "$CC" =~ ^[A-Z]{2}$ ]]; then
    warn "country detection failed — selection will cascade to global"
    CC=""
  else
    log "country: $CC (detected)"
  fi
fi

# ── Rewrite a single cfg ────────────────────────────────────────────────────
# Atomic: write to .tmp + mv; awk removes ALL existing nserver lines and
# inserts the two new ones right after the `daemon` directive.
rewrite_cfg() {
  local cfg="$1" ip1="$2" ip2="$3"
  local tmp
  tmp=$(mktemp "${cfg}.XXXXXX") || return 1
  awk -v ip1="$ip1" -v ip2="$ip2" '
    BEGIN { inserted = 0 }
    /^[[:space:]]*nserver[[:space:]]/ { next }
    /^[[:space:]]*daemon([[:space:]]|$)/ && !inserted {
      print
      print "  nserver " ip1
      print "  nserver " ip2
      inserted = 1
      next
    }
    { print }
    END {
      if (!inserted) {
        # No `daemon` line found — append nservers at end so cfg is still valid.
        print "  nserver " ip1
        print "  nserver " ip2
      }
    }
  ' "$cfg" > "$tmp" || { rm -f "$tmp"; return 1; }

  # Sanity: exactly 2 nserver lines, file non-empty, preserves -p/-i/-e auth lines.
  local ns_count
  ns_count=$(grep -cE '^[[:space:]]*nserver[[:space:]]' "$tmp" || true)
  if [ ! -s "$tmp" ] || [ "$ns_count" -ne 2 ]; then
    rm -f "$tmp"
    return 1
  fi
  chmod --reference="$cfg" "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$cfg"
}

# ── Main loop ───────────────────────────────────────────────────────────────
shopt -s nullglob
total=0; updated=0; skipped_same=0; failed=0
sample_before=""; sample_after=""; sample_port=""

cfgs=( "$CFG_DIR"/3proxy_*.cfg )
total=${#cfgs[@]}
log "cfgs total: $total"
if [ "$total" -eq 0 ]; then
  warn "no 3proxy_*.cfg files found in $CFG_DIR — nothing to do"
  exit 0
fi

# Track unique selections so the report shows the spread.
declare -A pair_counts=()
chosen_strategy=""

for cfg in "${cfgs[@]}"; do
  port=$(basename "$cfg" .cfg | sed 's/^3proxy_//')
  if ! [[ "$port" =~ ^[0-9]+$ ]]; then
    failed=$((failed + 1))
    continue
  fi

  sel=$(dns_select_pair "$CC" "$port")
  ip1=$(printf '%s' "$sel" | sed -n '1p')
  ip2=$(printf '%s' "$sel" | sed -n '2p')
  strategy=$(printf '%s' "$sel" | sed -n '3p')
  chosen_strategy="$strategy"

  if [ -z "$ip1" ] || [ -z "$ip2" ]; then
    failed=$((failed + 1))
    continue
  fi

  pair_counts["${ip1},${ip2}"]=$(( ${pair_counts["${ip1},${ip2}"]:-0} + 1 ))

  current=$(awk '/^[[:space:]]*nserver[[:space:]]/ {print $2}' "$cfg" \
            | head -n 2 | paste -sd, -)
  if [ "$current" = "${ip1},${ip2}" ]; then
    skipped_same=$((skipped_same + 1))
    continue
  fi

  if [ "$dry_run" -eq 1 ]; then
    if [ -z "$sample_before" ]; then
      sample_before="$current"
      sample_after="${ip1},${ip2}"
      sample_port="$port"
    fi
    updated=$((updated + 1))
    continue
  fi

  if rewrite_cfg "$cfg" "$ip1" "$ip2"; then
    updated=$((updated + 1))
    if [ -z "$sample_before" ]; then
      sample_before="$current"
      sample_after="${ip1},${ip2}"
      sample_port="$port"
    fi
  else
    failed=$((failed + 1))
  fi
done

# ── Restart ─────────────────────────────────────────────────────────────────
listening_before=0
listening_after=0
if [ "$dry_run" -eq 0 ] && [ "$no_restart" -eq 0 ] && [ "$updated" -gt 0 ]; then
  listening_before=$(ss -tln 2>/dev/null | grep -cE ':[1-9][0-9]{3,4} ' || true)
  log "restarting: pkill 3proxy + restore-3proxy.sh (BLIP — see header warning)"
  pkill -f "$PROXY_BIN" 2>/dev/null || true
  sleep 2
  if [ -x "$RESTORE_SCRIPT" ]; then
    bash "$RESTORE_SCRIPT" || warn "restore script returned non-zero (continuing)"
  else
    warn "restore script not executable: $RESTORE_SCRIPT — restart it manually"
  fi
  sleep 8
  listening_after=$(ss -tln 2>/dev/null | grep -cE ':[1-9][0-9]{3,4} ' || true)
fi

# ── Report ──────────────────────────────────────────────────────────────────
echo
echo "============================================================"
echo "  migrate_dns_inplace.sh — summary"
echo "============================================================"
echo "  mode               : $([ "$dry_run" -eq 1 ] && echo DRY-RUN || echo APPLY)"
echo "  country            : ${CC:-<unknown>}"
echo "  strategy (last)    : ${chosen_strategy:-n/a}"
echo "  cfg dir            : $CFG_DIR"
echo "  seed.json          : ${seed_path:-<not found>}"
echo "  cfgs total         : $total"
echo "  cfgs updated       : $updated"
echo "  cfgs skipped (==)  : $skipped_same"
echo "  cfgs failed        : $failed"
if [ -n "$sample_before" ]; then
  echo "  sample cfg port    : $sample_port"
  echo "    before nserver   : $sample_before"
  echo "    after  nserver   : $sample_after"
fi
echo "  unique nserver pairs (with count):"
for pair in "${!pair_counts[@]}"; do
  printf "%6d  %s\n" "${pair_counts[$pair]}" "$pair"
done | sort -rn | head -10 | awk '{printf "      ×%-4s %s\n", $1, $2}'
if [ "$dry_run" -eq 0 ] && [ "$no_restart" -eq 0 ] && [ "$updated" -gt 0 ]; then
  echo "  listening (before) : $listening_before"
  echo "  listening (after)  : $listening_after"
fi
echo "============================================================"

if [ "$failed" -gt 0 ]; then
  exit 1
fi
exit 0
