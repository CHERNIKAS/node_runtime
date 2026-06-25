"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PROXY_ROOT = path.normalize(process.env.NODE_AGENT_PROXY_ROOT || "/opt/netrun/proxyserver");
const PROXY_CFG_DIR = path.join(PROXY_ROOT, "3proxy");
const PROXY_BIN = path.join(PROXY_ROOT, "3proxy", "bin", "3proxy");
const NFT_TABLE = "proxy_accounting";
const COUNTER_NAME_RE = /^proxy_(\d+)_(in6|in|out)$/;
// Grace before force-killing a 3proxy on disable. 3proxy treats SIGTERM as a
// GRACEFUL shutdown — it stops accepting NEW connections but lets in-flight
// ones run to completion. For pay-per-GB enforcement that let an active
// download stream unbounded past the quota (revenue leak). We give SIGTERM a
// short window to exit cleanly, then SIGKILL any survivor to sever the live
// session. Overridable for tests via NODE_AGENT_DISABLE_GRACE_MS.
const DISABLE_GRACE_MS = Number(process.env.NODE_AGENT_DISABLE_GRACE_MS || 2000);
// Audit the active grace per node (phased rollout: un-patched nodes don't
// force-kill, patched ones do — make each node's setting visible in the log).
console.log(`[accounting] disable force-kill grace: DISABLE_GRACE_MS=${DISABLE_GRACE_MS}`);

// Per-port disable "generation" token. disablePort and enablePort both bump it;
// the deferred force-kill captures the token when armed and aborts if it has
// since changed. Closes the critical race where an enablePort (rebuy / watchdog
// reactivation) lands inside the grace window — without the guard the stale
// SIGKILL would re-resolve the port's pids and kill the proxy the user JUST
// paid to bring back. Bounded by the finite set of ports.
const _disableGen = new Map();
function _bumpDisableGen(port) {
  const next = (_disableGen.get(port) || 0) + 1;
  _disableGen.set(port, next);
  return next;
}

class PortNotFoundError extends Error {
  constructor(port) {
    super(`port_not_found: ${port}`);
    this.name = "PortNotFoundError";
    this.code = "PORT_NOT_FOUND";
    this.port = port;
  }
}

class NftablesError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "NftablesError";
    this.code = "NFTABLES_ERROR";
    this.detail = detail;
  }
}

class ProcessSpawnError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "ProcessSpawnError";
    this.code = "PROCESS_SPAWN_ERROR";
    this.detail = detail;
  }
}

function execCapture(cmd, args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: String(err && err.message || err), spawnError: err });
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString("utf-8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf-8"); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || String(err && err.message || err), spawnError: err });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: typeof code === "number" ? code : -1, stdout, stderr });
    });
  });
}

function configPathForPort(port) {
  return path.join(PROXY_CFG_DIR, `3proxy_${port}.cfg`);
}

// Audit WI-5 (H16) — a disabled port whose cfg stays as `3proxy_<port>.cfg`
// gets respawned by the reboot restore scripts (which glob `3proxy_*.cfg`),
// silently reviving a depleted/disabled pay-per-GB port. Demoting renames the
// cfg to `3proxy_<port>.cfg.disabled` (NOT matched by the glob); enablePort
// promotes it back to the live name.
function disabledConfigPathForPort(port) {
  return path.join(PROXY_CFG_DIR, `3proxy_${port}.cfg.disabled`);
}

function _demoteCfg(cfg, portNum) {
  // Rename the live cfg out of the restore glob. ENOENT = a concurrent disable
  // already moved it (no-op); anything else is a real failure.
  try {
    fs.renameSync(cfg, disabledConfigPathForPort(portNum));
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw new ProcessSpawnError("cfg_disable_rename_failed", String((err && err.message) || err));
  }
  return true;
}

async function findRunningPids(port) {
  const pattern = `3proxy_${port}.cfg`;
  const result = await execCapture("pgrep", ["-f", pattern]);
  if (result.code === 0) {
    return result.stdout
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map(Number);
  }
  if (result.code === 1) {
    return [];
  }
  throw new ProcessSpawnError("pgrep_failed", result.stderr || `exit ${result.code}`);
}

async function getCountersForPorts(ports) {
  const requested = new Set(
    (ports || [])
      .map((p) => Number(p))
      .filter((p) => Number.isInteger(p) && p > 0)
  );
  if (requested.size === 0) return {};

  const result = await execCapture("nft", ["-j", "list", "counters", "table", "inet", NFT_TABLE]);
  if (result.code !== 0) {
    throw new NftablesError("nft_list_counters_failed", result.stderr || `exit ${result.code}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch (err) {
    throw new NftablesError("nft_json_parse_failed", String(err && err.message || err));
  }
  const items = Array.isArray(parsed && parsed.nftables) ? parsed.nftables : [];

  const buckets = new Map();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const counter = item.counter;
    if (!counter || typeof counter !== "object") continue;
    if (counter.family !== "inet" || counter.table !== NFT_TABLE) continue;
    const m = COUNTER_NAME_RE.exec(String(counter.name || ""));
    if (!m) continue;
    const port = Number(m[1]);
    const kind = m[2];
    if (!requested.has(port)) continue;
    if (!buckets.has(port)) buckets.set(port, { in: 0, out: 0, in6: 0, present: false });
    const bucket = buckets.get(port);
    bucket.present = true;
    bucket[kind] = Number(counter.bytes) || 0;
  }

  const out = {};
  for (const [port, b] of buckets) {
    if (!b.present) continue;
    // Wave PERGB-METER-FIX — _in = client->proxy upload, _out = proxy->client
    // download (BILLABLE), both family-agnostic (client-port rules). The legacy
    // v6-egress `in6` counter is retired (it captured ~0 under dual-stack); on a
    // not-yet-reaccounted node it's still parsed into b.in6 but no longer summed
    // (it was egress-IPv6 garbage), so we read b.in alone.
    out[String(port)] = {
      bytes_in: b.in,
      bytes_out: b.out,
    };
  }
  return out;
}

// ── PERGB-NFT-ENFORCE — firewall-level pay-per-GB quota block ───────────────
// disablePort/enablePort historically renamed the per-port 3proxy_<port>.cfg
// and SIGKILLed its process. On block-config nodes only the block-START port
// owns a per-port cfg; every mid-block port has none, so the old path was a
// silent no-op (PORT_NOT_FOUND -> 404): a depleted pay-per-GB account kept
// serving past quota (revenue leak) and the orchestrator looped re-enabling it
// forever. We add enforcement that works for ANY port: one
// `tcp dport @pergb_blocked drop` rule on the proxy_accounting input chain,
// toggled by set membership. Validated live (block -> egress dies instantly,
// unblock -> restored). Best-effort + idempotent; membership is persisted and
// re-applied on boot (reapplyPergbBlocks) so a reboot can't silently un-block.
const NFT_BLOCK_SET = "pergb_blocked";
const HTTP_PORT_OFFSET = 10000; // paired http port = socks port - 10000
const BLOCKED_LIST_FILE = path.join(PROXY_ROOT, "pergb_blocked.list");

function _httpFor(portNum) {
  const h = portNum - HTTP_PORT_OFFSET;
  return h > 0 ? h : null;
}

function _readBlockedList() {
  try {
    return new Set(
      fs
        .readFileSync(BLOCKED_LIST_FILE, "utf-8")
        .split(/\s+/)
        .filter((s) => /^\d+$/.test(s))
        .map(Number)
    );
  } catch {
    return new Set();
  }
}

function _writeBlockedList(set) {
  try {
    fs.writeFileSync(
      BLOCKED_LIST_FILE,
      [...set].sort((a, b) => a - b).join("\n") + "\n"
    );
  } catch (err) {
    console.error(
      `[accounting] failed to persist ${BLOCKED_LIST_FILE}: ${(err && err.message) || err}`
    );
  }
}

// Idempotently ensure our block set + the single drop rule sit on top of the
// proxy_accounting input chain (the table/chain are created by the proxy
// accounting setup; we only add our set + one rule).
async function ensurePergbBlockInfra() {
  await execCapture("nft", ["add", "table", "inet", NFT_TABLE]);
  await execCapture("nft", [
    "add", "chain", "inet", NFT_TABLE, "input",
    "{", "type", "filter", "hook", "input", "priority", "filter", ";", "policy", "accept", ";", "}",
  ]);
  await execCapture("nft", [
    "add", "set", "inet", NFT_TABLE, NFT_BLOCK_SET,
    "{", "type", "inet_service", ";", "}",
  ]);
  const cur = await execCapture("nft", ["list", "chain", "inet", NFT_TABLE, "input"]);
  if (!new RegExp("@" + NFT_BLOCK_SET + "[\\s\\S]*drop").test(cur.stdout || "")) {
    await execCapture("nft", [
      "insert", "rule", "inet", NFT_TABLE, "input",
      "tcp", "dport", "@" + NFT_BLOCK_SET, "drop",
    ]);
  }
}

async function _nftSetElement(op, portNum) {
  await execCapture("nft", [
    op, "element", "inet", NFT_TABLE, NFT_BLOCK_SET, "{", String(portNum), "}",
  ]);
}

// Apply (blocked=true) or lift (blocked=false) the firewall block for a port +
// its paired http port. Best-effort: nft failures are logged, never thrown —
// the orchestrator reconciles and reapplyPergbBlocks restores on boot.
async function _enforceBlock(portNum, blocked) {
  const http = _httpFor(portNum);
  try {
    await ensurePergbBlockInfra();
    await _nftSetElement(blocked ? "add" : "delete", portNum);
    if (http) await _nftSetElement(blocked ? "add" : "delete", http);
  } catch (err) {
    console.error(
      `[accounting] nft ${blocked ? "block" : "unblock"} port ${portNum} failed: ${(err && err.message) || err}`
    );
  }
  const list = _readBlockedList();
  if (blocked) {
    list.add(portNum);
    if (http) list.add(http);
  } else {
    list.delete(portNum);
    if (http) list.delete(http);
  }
  _writeBlockedList(list);
}

// Re-assert every persisted block. Call on agent startup: a reboot clears the
// in-memory nft set and respawns all 3proxy from cfg, which would otherwise
// silently un-block depleted pay-per-GB accounts.
async function reapplyPergbBlocks() {
  const list = _readBlockedList();
  if (list.size === 0) return { reapplied: 0 };
  try {
    await ensurePergbBlockInfra();
    for (const p of list) await _nftSetElement("add", p);
  } catch (err) {
    console.error(`[accounting] reapplyPergbBlocks failed: ${(err && err.message) || err}`);
  }
  console.log(`[accounting] reapplied ${list.size} pergb firewall block(s)`);
  return { reapplied: list.size };
}

// Block a pay-per-GB port: firewall-drop it (works for every port, incl.
// mid-block) THEN best-effort tear down its per-port cfg/process (block-START
// ports). A missing per-port cfg is no longer an error — the nft drop is the
// enforcement, so the account converges instead of 404-looping.
async function disablePort(port) {
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum <= 0) {
    throw new PortNotFoundError(port);
  }
  await _enforceBlock(portNum, true);
  try {
    return await _disablePortCfg(portNum);
  } catch (err) {
    if (err && err.code === "PORT_NOT_FOUND") {
      return { action: "blocked_nft_only", port: portNum };
    }
    throw err;
  }
}

async function _disablePortCfg(port) {
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum <= 0) {
    throw new PortNotFoundError(port);
  }
  // Bump FIRST so any in-flight force-kill from a prior disable of this port
  // (or a stale one superseded by a since-then enablePort) is invalidated.
  const gen = _bumpDisableGen(portNum);
  const cfg = configPathForPort(portNum);
  const cfgExists = fs.existsSync(cfg);
  const pids = await findRunningPids(portNum);

  if (pids.length === 0) {
    if (!cfgExists) {
      const counters = await getCountersForPorts([portNum]).catch(() => ({}));
      if (!counters[String(portNum)]) {
        throw new PortNotFoundError(portNum);
      }
      return { action: "already_disabled" };
    }
    // Audit WI-5 (H16) — no live proxy, but the cfg is still in the restore
    // glob; a reboot would revive this disabled port. Demote so restore skips it.
    _demoteCfg(cfg, portNum);
    return { action: "already_disabled", cfgDisabled: true };
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      if (err && err.code !== "ESRCH") {
        throw new ProcessSpawnError("kill_failed", String(err && err.message || err));
      }
    }
  }
  // Audit WI-5 (H16) — demote the cfg so a reboot's restore glob skips this
  // port, even while the async force-kill below is still draining survivors.
  if (cfgExists) {
    _demoteCfg(cfg, portNum);
  }
  // SIGTERM is graceful — 3proxy keeps an already-established connection (e.g.
  // a large download) alive, which defeats pay-per-GB quota enforcement. After
  // a short grace, force-kill any survivor. We RE-RESOLVE the pids for THIS
  // port at kill time (not the captured list) so we never SIGKILL a recycled
  // PID — pgrep on `3proxy_<port>.cfg` only matches a 3proxy still serving this
  // exact port. The generation guard aborts if an enablePort/disablePort for
  // this port ran in the meantime, so we never kill a freshly RE-ENABLED proxy
  // (rebuy / watchdog reactivation inside the grace window). Fire-and-forget +
  // unref so the disable ack returns now and the timer never keeps the agent
  // (or a test) alive on its own.
  if (DISABLE_GRACE_MS >= 0) {
    const timer = setTimeout(() => {
      if (_disableGen.get(portNum) !== gen) {
        return; // superseded by a later enable/disable — do NOT kill.
      }
      findRunningPids(portNum)
        .then((survivors) => {
          if (_disableGen.get(portNum) !== gen) {
            return; // re-check after the async pgrep hop.
          }
          let killed = 0;
          for (const pid of survivors) {
            try {
              process.kill(pid, "SIGKILL");
              killed += 1;
            } catch (_err) {
              // Already exited after the graceful SIGTERM — nothing to force.
            }
          }
          if (killed > 0) {
            console.log(
              `[accounting.disablePort] force-killed ${killed} survivor(s) on port ${portNum} after ${DISABLE_GRACE_MS}ms grace`
            );
          }
        })
        .catch((err) => {
          // A money-path enforcement primitive must NOT fail silently: the HTTP
          // ack already returned "killed", so a swallowed error here means the
          // survivor streams on with nobody the wiser. Log loudly; the next
          // poll-cycle disable retry is the backstop.
          console.error(
            `[accounting.disablePort] force-kill check failed on port ${portNum}: ${
              (err && err.message) || err
            }`
          );
        });
    }, DISABLE_GRACE_MS);
    if (typeof timer.unref === "function") timer.unref();
  }
  return { action: "killed", pids };
}

// Unblock a pay-per-GB port: lift the firewall drop THEN best-effort re-spawn
// its per-port cfg (block-START ports). A missing per-port cfg is no longer an
// error — lifting the nft drop is what restores a mid-block port.
async function enablePort(port) {
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum <= 0) {
    throw new PortNotFoundError(port);
  }
  await _enforceBlock(portNum, false);
  try {
    return await _enablePortCfg(portNum);
  } catch (err) {
    if (err && err.code === "PORT_NOT_FOUND") {
      return { action: "unblocked_nft_only", port: portNum };
    }
    throw err;
  }
}

async function _enablePortCfg(port) {
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum <= 0) {
    throw new PortNotFoundError(port);
  }
  // Invalidate any pending force-kill from a recent disablePort of this port:
  // re-enabling means we must NOT let a stale SIGKILL drop the proxy we're
  // about to (re)spawn. Bump before spawning so the timer's generation check
  // fails even if it fires mid-spawn.
  _bumpDisableGen(portNum);
  const cfg = configPathForPort(portNum);
  // Audit WI-5 (H16) — promote a previously-demoted cfg back to the live name
  // so spawn, the reboot restore glob, and pgrep all agree on `3proxy_<port>.cfg`.
  const disabledCfg = disabledConfigPathForPort(portNum);
  if (!fs.existsSync(cfg) && fs.existsSync(disabledCfg)) {
    fs.renameSync(disabledCfg, cfg);
  }
  if (!fs.existsSync(cfg)) {
    throw new PortNotFoundError(portNum);
  }

  const pids = await findRunningPids(portNum);
  if (pids.length > 0) {
    return { action: "already_enabled", pids };
  }

  if (!fs.existsSync(PROXY_BIN)) {
    throw new ProcessSpawnError("3proxy_binary_missing", PROXY_BIN);
  }

  let child;
  try {
    child = spawn(PROXY_BIN, [cfg], {
      detached: true,
      stdio: "ignore",
    });
  } catch (err) {
    throw new ProcessSpawnError("3proxy_spawn_failed", String(err && err.message || err));
  }
  const pid = child.pid;
  child.unref();
  return { action: "started", pid };
}

module.exports = {
  getCountersForPorts,
  disablePort,
  enablePort,
  PortNotFoundError,
  NftablesError,
  ProcessSpawnError,
  // Exposed for the generation-guard unit test (no pgrep dependency).
  _bumpDisableGen,
  _disableGen,
  DISABLE_GRACE_MS,
  // Audit WI-5 (H16) — cfg demote/promote lifecycle, exported for unit tests.
  configPathForPort,
  disabledConfigPathForPort,
  _demoteCfg,
  // PERGB-NFT-ENFORCE — firewall block lifecycle (agent-startup reapply hook +
  // exported for unit tests).
  reapplyPergbBlocks,
  ensurePergbBlockInfra,
  _enforceBlock,
  _readBlockedList,
  _writeBlockedList,
  _httpFor,
  BLOCKED_LIST_FILE,
  NFT_BLOCK_SET,
};
