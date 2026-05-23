#!/usr/bin/env bash
# NETRUN — apply hardening to a LEGACY node (one that was provisioned
# before install_node.sh was extended with conntrack/FD/UFW/DNS/MSS
# hardening). Safe to run multiple times — every block is idempotent.
#
# Triggered after the 2026-05-13 mass outage: 5 nodes installed before
# the hardening went in turned out to lock up under 500-port pergb
# generation load (conntrack table saturated → kernel network stack
# hung → no ICMP, no SSH). This script catches those nodes up to the
# install_node.sh baseline without re-installing the agent.
#
# Usage from the orch box:
#   ssh -o StrictHostKeyChecking=no root@$NODE_IP 'bash -s' < harden_only.sh
# Or in a loop across all 5 legacy nodes — see README at bottom.
#
# Verify after with:
#   ssh root@$NODE_IP 'sysctl net.netfilter.nf_conntrack_max; ufw status; cat /proc/sys/net/netfilter/nf_conntrack_count'

set -euo pipefail

SYSCTL_FILE="/etc/sysctl.d/99-netrun.conf"
LIMITS_FILE="/etc/security/limits.d/99-netrun.conf"
RESOLV_CONF="/etc/resolv.conf"

log()  { printf "\033[01;32m[harden]\033[0m %s\n" "$*"; }
warn() { printf "\033[01;33m[harden]\033[0m %s\n" "$*"; }

# ── 1) Sysctl: conntrack, FD, port range, backlog ────────────────
log "Configuring sysctl"
cat > "$SYSCTL_FILE" <<'EOF'
# === IPv6 forwarding (nftables accounting + 3proxy IPv6 egress) ===
net.ipv6.ip_nonlocal_bind = 1
net.ipv6.conf.all.forwarding = 1
net.ipv6.conf.default.forwarding = 1

# === High-connection tuning ===
# Default ~256k conntrack saturates around 4000 active proxies; 1M
# entries handles 100k+ concurrent without deadlock.
net.netfilter.nf_conntrack_max = 1048576
net.netfilter.nf_conntrack_tcp_timeout_established = 7200

# TCP backlog: handle bursts of new connections without dropping.
net.ipv4.tcp_max_syn_backlog = 8192
net.core.somaxconn = 8192

# Local port range: preserves <10000 for 3proxy listeners.
net.ipv4.ip_local_port_range = 10000 65000

# Filesystem: 2M open file descriptors.
fs.file-max = 2097152

# === TCP/IP fingerprint normalization (Android-like) ===
# tcp_timestamps=1: Linux/Android default. =0 makes p0f read OS as Windows.
# tcp_mtu_probing=1: PLPMTUD — discovers PMTU dynamically; safer than fixed
# MSS-clamp (which produced MTU=1380 → p0f classified link as OpenVPN).
net.ipv4.tcp_timestamps = 1
net.ipv4.tcp_mtu_probing = 1

# IPv6: don't reverse-path filter on multi-homed (Vultr quirks).
net.ipv6.conf.all.accept_ra = 2
net.ipv6.conf.default.accept_ra = 2
EOF
# Strip any legacy tcp_timestamps line from /etc/sysctl.conf — old generator
# wrote =0 there, which is processed AFTER sysctl.d and would override our =1.
if [ -f /etc/sysctl.conf ]; then
  sed -i -E '/^[[:space:]]*net\.ipv4\.tcp_timestamps[[:space:]]*=/d' /etc/sysctl.conf || true
fi
sysctl --system >/dev/null 2>&1 || true
sysctl -p "$SYSCTL_FILE" >/dev/null

# ── 2) File descriptor limits ────────────────────────────────────
log "Configuring file descriptor limits (1M open FDs)"
cat > "$LIMITS_FILE" <<'EOF'
root soft nofile 1048576
root hard nofile 1048576
*    soft nofile 1048576
*    hard nofile 1048576
EOF
mkdir -p /etc/systemd/system.conf.d
cat > /etc/systemd/system.conf.d/99-netrun-limits.conf <<'EOF'
[Manager]
DefaultLimitNOFILE=1048576
EOF
systemctl daemon-reexec >/dev/null 2>&1 || true

# ── 3) UFW: disable + purge + mask so it can never come back ────
log "Removing UFW (default-deny breaks high-port ranges after reboot)"
if command -v ufw >/dev/null 2>&1; then
  ufw --force disable 2>/dev/null || true
  DEBIAN_FRONTEND=noninteractive apt-get purge -y ufw 2>/dev/null || true
fi
systemctl mask ufw 2>/dev/null || true

# ── 4) Pin DNS resolvers (Vultr regional DNS unreliable) ────────
log "Pinning /etc/resolv.conf to Cloudflare + Google"
chattr -i "$RESOLV_CONF" 2>/dev/null || true
cat > "$RESOLV_CONF" <<'EOF'
# NETRUN: pinned to Cloudflare + Google + IPv6 equivalents.
nameserver 1.1.1.1
nameserver 8.8.8.8
nameserver 2606:4700:4700::1111
nameserver 2001:4860:4860::8888
options edns0 trust-ad timeout:2 attempts:1
EOF
chattr +i "$RESOLV_CONF" 2>/dev/null || true

# ── 5) nftables: ensure proxy_normalization + MSS clamp ─────────
log "Configuring nftables MSS clamping"
apt-get install -y nftables >/dev/null 2>&1 || true
systemctl enable nftables >/dev/null 2>&1 || true
systemctl start  nftables >/dev/null 2>&1 || true

nft add table inet proxy_normalization 2>/dev/null || true
nft add chain inet proxy_normalization output \
  '{ type filter hook output priority -150; policy accept; }' 2>/dev/null || true
nft add chain inet proxy_normalization postrouting \
  '{ type filter hook postrouting priority -150; policy accept; }' 2>/dev/null || true

nft add table inet proxy_accounting 2>/dev/null || true
nft add chain inet proxy_accounting input \
  '{ type filter hook input priority 0; policy accept; }' 2>/dev/null || true
nft add chain inet proxy_accounting output \
  '{ type filter hook output priority 0; policy accept; }' 2>/dev/null || true

# MSS clamp on SYN out — clamp to 1460 (Android/Ethernet default for MTU 1500).
# Previous 1340 produced MTU=1380 → p0f classified as OpenVPN. PMTU edge cases
# now covered by net.ipv4.tcp_mtu_probing=1 set in sysctl above.
# Idempotency: delete any legacy 1340 clamp rule first, then ensure 1460 exists.
legacy_handle=$(nft -a list chain inet proxy_normalization output 2>/dev/null \
  | awk '/size set 1340/ {for(i=1;i<=NF;i++) if($i=="handle") {print $(i+1); exit}}')
if [ -n "$legacy_handle" ]; then
  nft delete rule inet proxy_normalization output handle "$legacy_handle" 2>/dev/null || true
fi
if ! nft list chain inet proxy_normalization output 2>/dev/null | grep -q 'size set 1460'; then
  nft add rule inet proxy_normalization output \
    meta l4proto tcp tcp flags syn tcp option maxseg size set 1460
fi
nft list ruleset > /etc/nftables.conf

# ── 6) Restart node-agent so it picks up new ulimits ───────────
if systemctl list-units --full -all | grep -q 'netrun-node-agent.service'; then
  log "Restarting netrun-node-agent (new FD limits in effect)"
  systemctl restart netrun-node-agent
  sleep 2
  systemctl is-active netrun-node-agent && log "agent: active" || warn "agent NOT active!"
else
  warn "netrun-node-agent.service not found — agent install may be incomplete"
fi

# ── 7) Quick post-condition probe ───────────────────────────────
log "─── Post-condition checks ───"
printf "  nf_conntrack_max : "
sysctl -n net.netfilter.nf_conntrack_max
printf "  nf_conntrack_used: "
cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || echo "(module not loaded yet)"
printf "  fs.file-max      : "
sysctl -n fs.file-max
printf "  ufw status       : "
if command -v ufw >/dev/null 2>&1; then
  ufw status | head -1
else
  echo "(uninstalled — correct)"
fi
printf "  MSS clamp rule   : "
nft list chain inet proxy_normalization output 2>/dev/null \
  | grep -q 'size set 1460' && echo "present (1460)" || echo "MISSING"
printf "  tcp_timestamps   : "
sysctl -n net.ipv4.tcp_timestamps
printf "  tcp_mtu_probing  : "
sysctl -n net.ipv4.tcp_mtu_probing
printf "  8085 listening   : "
ss -tlnp 2>/dev/null | grep -q ':8085 ' && echo "yes" || echo "NO"

log "Hardening complete on $(hostname)"

# ─────────────────────────────────────────────────────────────────
# README — one-liner loop to harden all 5 legacy nodes from orch box:
#
#   SCRIPT=$(realpath harden_only.sh)
#   for ip in 45.76.37.225 149.28.119.9 65.20.80.77 \
#             45.32.253.174 70.34.255.149; do
#     echo "═══ $ip ═══"
#     ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no \
#         root@$ip 'bash -s' < "$SCRIPT"
#   done
#
# (Frankfurt 136.244.87.32 omitted — already hardened by install_node.sh
#  during fresh install.)
