#!/bin/bash
# NETRUN — shared DNS-selection helpers, used by both the generator
# (configure_dns_servers) and scripts/migrate_dns_inplace.sh so they
# pick the exact same pair for a given (country, rotation_key).
#
# This file is SOURCED, not executed. Never put top-level side-effects here.

# Locate the bundled dns/seed.json. Stdout: absolute path, or empty + rc=1.
function locate_dns_seed() {
  local script_dir=""
  script_dir=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")")" 2>/dev/null && pwd -P 2>/dev/null) || script_dir=""
  local candidates=(
    "${NETRUN_HOME:-/opt/netrun}/dns/seed.json"
    "/opt/netrun/dns/seed.json"
    "${script_dir}/seed.json"
    "${script_dir}/../dns/seed.json"
    "${script_dir}/../../dns/seed.json"
    "${script_dir}/../../../dns/seed.json"
  )
  local p=""
  for p in "${candidates[@]}"; do
    if [ -n "$p" ] && [ -f "$p" ]; then echo "$p"; return 0; fi;
  done
  return 1
}

# Deterministic pair selection.
# Args: <country_code_uppercase_or_empty> <rotation_key>
# Stdout: three lines — ip1, ip2, strategy.
#   strategy ∈ {seed_country, seed_continent, seed_global, hardcoded_fallback}
# The same (country, rotation_key, seed.json content) ALWAYS yields the
# same pair, so the generator and the migrate script stay coherent.
function dns_select_pair() {
  local cc="${1:-}"
  local rot_key="${2:-0}"

  # Hardcoded last-resort fallback (Quad9 + Cisco OpenDNS anycast).
  local -a hardcoded_global_v4=("9.9.9.9" "149.112.112.112" "208.67.222.222" "208.67.220.220")

  local seed_path=""
  seed_path=$(locate_dns_seed || true)

  local -a country_pool=() continent_pool=() global_pool=()
  local resolved_continent=""

  if [ -n "$seed_path" ] && command -v jq >/dev/null 2>&1; then
    if [[ "$cc" =~ ^[A-Z]{2}$ ]]; then
      mapfile -t country_pool < <(jq -r --arg cc "$cc" \
        '.countries[$cc].v4 // [] | .[]' "$seed_path" 2>/dev/null)
      resolved_continent=$(jq -r --arg cc "$cc" \
        '.country_to_continent[$cc] // ""' "$seed_path" 2>/dev/null \
        | tr '[:lower:]' '[:upper:]')
    fi;
    if [[ "$resolved_continent" =~ ^[A-Z]{2}$ ]]; then
      mapfile -t continent_pool < <(jq -r --arg kc "$resolved_continent" \
        '.continents[$kc].v4 // [] | .[]' "$seed_path" 2>/dev/null)
    fi;
    mapfile -t global_pool < <(jq -r '.global.v4 // [] | .[]' "$seed_path" 2>/dev/null)
  fi;

  # Backfill global tier from hardcoded list if seed had no global.
  if [ ${#global_pool[@]} -eq 0 ]; then global_pool=("${hardcoded_global_v4[@]}"); fi;

  # Cascade: country (≥2) → +continent (≥2) → +global.
  local strategy=""
  local -a candidates=()
  if [ ${#country_pool[@]} -ge 2 ]; then
    candidates=("${country_pool[@]}")
    strategy="seed_country"
  elif [ $(( ${#country_pool[@]} + ${#continent_pool[@]} )) -ge 2 ]; then
    candidates=("${country_pool[@]}" "${continent_pool[@]}")
    strategy="seed_continent"
  else
    candidates=("${country_pool[@]}" "${continent_pool[@]}" "${global_pool[@]}")
    strategy="seed_global"
  fi;

  # Defensive — shouldn't trigger because global_pool always ≥2.
  if [ ${#candidates[@]} -lt 2 ]; then
    candidates=("${hardcoded_global_v4[@]}")
    strategy="hardcoded_fallback"
  fi;

  # Rotation: cksum("rot:${rot_key}:${cc}") mod N.
  local total=${#candidates[@]}
  local hash_seed=0
  hash_seed=$(printf '%s' "rot:${rot_key}:${cc:-XX}" | cksum | awk '{print $1}')
  local off1=$(( hash_seed % total ))
  local off2=$(( (hash_seed + 1) % total ))
  if [ "$off1" = "$off2" ] && [ "$total" -gt 1 ]; then off2=$(( (off1 + 1) % total )); fi;

  printf '%s\n%s\n%s\n' "${candidates[$off1]}" "${candidates[$off2]}" "$strategy"
}
