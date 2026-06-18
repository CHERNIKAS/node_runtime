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

async function disablePort(port) {
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

async function enablePort(port) {
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
};
