#!/usr/bin/env bash
# Wave NODE-NEW-MODERNIZE — quick-install.sh must clone the CANONICAL repo
# (node_runtime_new), not the dead node_runtime. Cloud-init already targets
# node_runtime_new; this guards the one-line installer path. Run with:
#   bash scripts/test_quick_install_repo.sh
set -euo pipefail

QI="$(dirname "$0")/quick-install.sh"
fail() { echo "FAIL: $1"; exit 1; }

# Default REPO_URL points at node_runtime_new.
grep -q '^REPO_URL="https://github.com/Tmwyw/node_runtime_new.git"' "$QI" \
  || fail "quick-install REPO_URL not node_runtime_new"
echo "ok: quick-install REPO_URL → node_runtime_new.git"

# No lingering clone-source reference to the dead repo (node_runtime without
# the _new suffix). The negative-lookahead via grep -P keeps node_runtime_new
# matches from counting.
if grep -nP 'Tmwyw/node_runtime(?!_new)' "$QI"; then
  fail "quick-install still references dead Tmwyw/node_runtime as clone-source"
fi
echo "ok: quick-install has no dead node_runtime clone-source reference"

echo "test_quick_install_repo.sh — all checks passed"
