#!/bin/bash
#
# Wave NODE-GENLOCK-HARDENING — REDIRECT SHIM (not the real generator).
#
# The canonical generator is node_runtime/soft/generator/proxyyy_automated.sh.
# It is the path the agent advertises and the orchestrator invokes:
#   - node_agent/describe.js getGeneratorScriptPath() lists soft/generator FIRST
#     in every candidate pair, so /describe always reports the soft/ copy;
#   - scripts/smoke_generate.sh and README.md both use
#     /opt/netrun/node_runtime/soft/generator/proxyyy_automated.sh.
#
# Two editable copies used to live side by side (this generator/ dir and
# soft/generator/). They drifted apart silently when only one was edited. To
# kill that hazard while keeping this filename resolvable (in case any stale
# config or older orchestrator still points here), this file is now a thin
# redirect that execs the one true script. There is nothing to edit here —
# change soft/generator/proxyyy_automated.sh instead.
#
# Flag-detection note: node_agent/server.js scriptSupportsFlag() reads the
# INVOKED script's text and does text.includes(<flag>) to decide which flags to
# pass. If this shim is ever the resolved path, those probes must still see the
# real generator's flags, so they are listed verbatim below. Keep this list in
# sync with soft/generator/proxyyy_automated.sh:
#   --backconnect-proxies-file --port-ipv6-map-file --runtime-only
#   --proxies-type --random --skip-self-check
#
set -euo pipefail

# Resolve the canonical script relative to this shim's real location so the
# redirect works regardless of the install prefix (/opt/netrun/... or a repo
# checkout). The sibling soft/ dir is one level up from this generator/ dir.
SHIM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
CANONICAL="$SHIM_DIR/../soft/generator/proxyyy_automated.sh"

if [ ! -f "$CANONICAL" ]; then
  echo "proxyyy_automated.sh redirect shim: canonical generator not found at $CANONICAL" >&2
  exit 1
fi

exec bash "$CANONICAL" "$@"
