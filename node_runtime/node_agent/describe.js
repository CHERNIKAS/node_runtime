"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const https = require("https");

const AGENT_VERSION = "1.0.0";

const GEO_CACHE_TTL_MS = 60 * 60 * 1000;
let _geoCache = null;
let _geoCacheAt = 0;

async function buildDescribe({ healthSnapshot, jobsRoot, proxyRoot } = {}) {
  const ipv6 = healthSnapshot?.ipv6 || null;
  const ipv6Egress = healthSnapshot?.ipv6Egress || null;
  const dns = healthSnapshot?.dns || null;

  return {
    agent_version: AGENT_VERSION,
    node_runtime_commit: getGitCommit(),
    capacity: estimateCapacity(),
    max_parallel_jobs: 1,
    max_batch_size: 1500,
    generator_script: getGeneratorScriptPath(),
    geo_code: await detectGeoCode().catch(() => null),
    ipv6: ipv6,
    ipv6_egress: ipv6Egress,
    dns: dns,
    api_key_required: Boolean(String(process.env.NODE_AGENT_API_KEY || "").trim()),
    jobs_root: jobsRoot || process.env.NODE_AGENT_JOBS_ROOT || "/opt/netrun/jobs",
    proxy_root: proxyRoot || process.env.NODE_AGENT_PROXY_ROOT || "/opt/netrun/proxyserver",
    supports: {
      describe: true,
      accounting: true,
      enroll: true,
    },
  };
}

function getGitCommit() {
  try {
    return execSync("git rev-parse HEAD", {
      encoding: "utf-8",
      cwd: __dirname,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .slice(0, 12);
  } catch {
    return null;
  }
}

function estimateCapacity() {
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf-8");
    const memAvailableMatch = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo);
    if (!memAvailableMatch) return 5000;
    const memAvailableMB = Math.floor(Number(memAvailableMatch[1]) / 1024);
    const usableMB = Math.max(0, memAvailableMB - 200);
    const capacity = Math.floor(usableMB / 0.5);
    return Math.max(100, Math.min(5000, capacity));
  } catch {
    return 5000;
  }
}

function getGeneratorScriptPath() {
  const candidates = [
    "/opt/netrun/node_runtime/soft/generator/proxyyy_automated.sh",
    "/opt/netrun/node_runtime/generator/proxyyy_automated.sh",
    path.resolve(__dirname, "..", "soft", "generator", "proxyyy_automated.sh"),
    path.resolve(__dirname, "..", "generator", "proxyyy_automated.sh"),
    path.resolve(__dirname, "..", "..", "node_runtime", "soft", "generator", "proxyyy_automated.sh"),
    path.resolve(__dirname, "..", "..", "node_runtime", "generator", "proxyyy_automated.sh"),
    path.resolve(__dirname, "..", "..", "soft", "generator", "proxyyy_automated.sh"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // continue
    }
  }
  return null;
}

async function detectGeoCode() {
  const now = Date.now();
  if (_geoCache !== null && now - _geoCacheAt < GEO_CACHE_TTL_MS) {
    return _geoCache;
  }
  try {
    const country = await new Promise((resolve, reject) => {
      const req = https.get("https://ipapi.co/country", { timeout: 4000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`ipapi status ${res.statusCode}`));
          return;
        }
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve(body.trim()));
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("timeout")));
    });
    if (/^[A-Z]{2}$/.test(country)) {
      _geoCache = country;
      _geoCacheAt = now;
      return country;
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = { buildDescribe };
