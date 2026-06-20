"use strict";

// Wave NODE-GENLOCK-HARDENING — regression tests for the stale generation-lock
// bug that bricked the JP Tokyo node for 5 days. A prior generation crashed
// between fsp.open(lockPath,'wx') and writeFile, leaving a 0-byte
// .generation.lock; readJsonIfExists parsed it to null, so the old recovery
// path (which only fired for a parsed-object-with-dead-pid) was skipped and
// EVERY /generate returned node_busy. Meanwhile /health reported busy:false.
//
// Run with: node --test node_runtime/node_agent/server.genlock.test.js
// (or as part of: node --test node_runtime/node_agent/*.test.js)

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");

const {
  isGenerationLockStale,
  classifyGenerationLock,
  acquireGenerationLock,
  releaseGenerationLock,
  STALE_LOCK_MS,
} = require(path.resolve(__dirname, "server.js"));

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed += 1;
}
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
  passed += 1;
}

const ALIVE_PID = process.pid; // this test process is, definitionally, alive.
const DEAD_PID = 2147483646; // implausibly high pid → not alive.

async function mkTmp() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "netrun-genlock-"));
}

(async () => {
  // ---- Pure isGenerationLockStale verdicts -------------------------------
  const NOW = Date.parse("2026-06-21T12:00:00.000Z");
  const TTL = STALE_LOCK_MS;

  // (1) THE PROD BUG: empty/corrupt file → readJsonIfExists null → parsed null.
  ok(
    isGenerationLockStale(null, { now: NOW, ttlMs: TTL, pidAlive: false }),
    "1: empty/corrupt (parsed=null) lock is STALE"
  );

  // (2) live pid, fresh acquiredAt → NOT stale (genuine running generation).
  ok(
    !isGenerationLockStale(
      { pid: ALIVE_PID, acquiredAt: new Date(NOW - 5_000).toISOString() },
      { now: NOW, ttlMs: TTL, pidAlive: true }
    ),
    "2: live pid + fresh lock is LIVE (not stale)"
  );

  // (3) dead pid, fresh acquiredAt → STALE.
  ok(
    isGenerationLockStale(
      { pid: DEAD_PID, acquiredAt: new Date(NOW - 5_000).toISOString() },
      { now: NOW, ttlMs: TTL, pidAlive: false }
    ),
    "3: dead pid is STALE regardless of age"
  );

  // (4) TTL expiry: even a 'live' pid past the TTL window is STALE (pid reuse
  //     backstop). acquiredAt is older than ttl.
  ok(
    isGenerationLockStale(
      { pid: ALIVE_PID, acquiredAt: new Date(NOW - (TTL + 60_000)).toISOString() },
      { now: NOW, ttlMs: TTL, pidAlive: true }
    ),
    "4: live pid past TTL is STALE"
  );

  // (5) no acquiredAt, falls back to file mtime for age; live + recent mtime → live.
  ok(
    !isGenerationLockStale(
      { pid: ALIVE_PID },
      { now: NOW, ttlMs: TTL, pidAlive: true, fileMtimeMs: NOW - 1_000 }
    ),
    "5: live pid + recent mtime (no acquiredAt) is LIVE"
  );

  // (6) no acquiredAt, old mtime, live pid → STALE by mtime fallback.
  ok(
    isGenerationLockStale(
      { pid: ALIVE_PID },
      { now: NOW, ttlMs: TTL, pidAlive: true, fileMtimeMs: NOW - (TTL + 60_000) }
    ),
    "6: live pid + old mtime (no acquiredAt) is STALE"
  );

  // ---- Filesystem: classifyGenerationLock + acquireGenerationLock --------

  // (7) THE EXACT PROD REPRO: pre-create a 0-byte .generation.lock, then call
  //     acquireGenerationLock. It MUST recover (acquire) rather than node_busy.
  {
    const dir = await mkTmp();
    const lockPath = path.join(dir, ".generation.lock");
    await fsp.writeFile(lockPath, ""); // 0-byte, crash-between-open-and-write.
    ok(fs.statSync(lockPath).size === 0, "7a: pre-created lock is 0 bytes");

    const cls = await classifyGenerationLock(lockPath);
    eq(cls.parsed, null, "7b: 0-byte lock parses to null");
    ok(cls.stale === true, "7c: 0-byte lock classified STALE");

    const result = await acquireGenerationLock(lockPath, { jobId: "job-recover" });
    ok(result.ok === true, "7d: acquire RECOVERS from 0-byte lock (no node_busy)");
    ok(result.staleLockRecovered === true, "7e: acquire flags staleLockRecovered");
    const after = JSON.parse(await fsp.readFile(lockPath, "utf-8"));
    eq(after.jobId, "job-recover", "7f: our record was written");
    eq(after.pid, process.pid, "7g: lock now owned by our pid");
    await fsp.rm(dir, { recursive: true, force: true });
  }

  // (8) FRESH LIVE LOCK still blocks: a parseable lock with a LIVE pid and a
  //     recent acquiredAt must return node_busy (ok:false), not be stolen.
  {
    const dir = await mkTmp();
    const lockPath = path.join(dir, ".generation.lock");
    const liveRecord = {
      jobId: "job-live",
      ownerToken: "tok-live",
      pid: ALIVE_PID,
      acquiredAt: new Date().toISOString(),
    };
    await fsp.writeFile(lockPath, `${JSON.stringify(liveRecord, null, 2)}\n`);

    const result = await acquireGenerationLock(lockPath, { jobId: "job-intruder" });
    ok(result.ok === false, "8a: acquire is REFUSED by a live lock (node_busy)");
    eq(result.existingLock.jobId, "job-live", "8b: existingLock surfaces the live job");
    // The live lock file must be untouched.
    const stillThere = JSON.parse(await fsp.readFile(lockPath, "utf-8"));
    eq(stillThere.jobId, "job-live", "8c: live lock left intact");
    await fsp.rm(dir, { recursive: true, force: true });
  }

  // (9) STALE-BY-TTL lock is reclaimed: parseable, live-looking pid, but
  //     acquiredAt far in the past → acquire recovers.
  {
    const dir = await mkTmp();
    const lockPath = path.join(dir, ".generation.lock");
    const oldRecord = {
      jobId: "job-ancient",
      ownerToken: "tok-old",
      pid: ALIVE_PID,
      acquiredAt: new Date(Date.now() - (STALE_LOCK_MS + 120_000)).toISOString(),
    };
    await fsp.writeFile(lockPath, `${JSON.stringify(oldRecord, null, 2)}\n`);

    const cls = await classifyGenerationLock(lockPath);
    ok(cls.stale === true, "9a: TTL-expired lock classified STALE");
    const result = await acquireGenerationLock(lockPath, { jobId: "job-fresh" });
    ok(result.ok === true, "9b: acquire reclaims a TTL-expired lock");
    const after = JSON.parse(await fsp.readFile(lockPath, "utf-8"));
    eq(after.jobId, "job-fresh", "9c: fresh job now owns the lock");
    await fsp.rm(dir, { recursive: true, force: true });
  }

  // (10) DEAD-PID lock (the case the OLD code already handled) still recovers.
  {
    const dir = await mkTmp();
    const lockPath = path.join(dir, ".generation.lock");
    const deadRecord = {
      jobId: "job-dead",
      ownerToken: "tok-dead",
      pid: DEAD_PID,
      acquiredAt: new Date().toISOString(),
    };
    await fsp.writeFile(lockPath, `${JSON.stringify(deadRecord, null, 2)}\n`);

    const result = await acquireGenerationLock(lockPath, { jobId: "job-after-dead" });
    ok(result.ok === true, "10a: acquire recovers from a dead-pid lock");
    ok(result.staleLockRecovered === true, "10b: staleLockRecovered flagged");
    await fsp.rm(dir, { recursive: true, force: true });
  }

  // (11) release only removes OUR lock; a foreign-token release is a no-op.
  {
    const dir = await mkTmp();
    const lockPath = path.join(dir, ".generation.lock");
    const acquired = await acquireGenerationLock(lockPath, { jobId: "job-rel" });
    ok(acquired.ok === true, "11a: acquired fresh lock");
    await releaseGenerationLock(lockPath, "not-our-token");
    ok(fs.existsSync(lockPath), "11b: foreign-token release left lock in place");
    await releaseGenerationLock(lockPath, acquired.lockRecord.ownerToken);
    ok(!fs.existsSync(lockPath), "11c: owner-token release removed the lock");
    await fsp.rm(dir, { recursive: true, force: true });
  }

  // (12) acquire on a completely fresh path (no lock) succeeds plainly.
  {
    const dir = await mkTmp();
    const lockPath = path.join(dir, ".generation.lock");
    const result = await acquireGenerationLock(lockPath, { jobId: "job-clean" });
    ok(result.ok === true && !result.staleLockRecovered, "12: clean acquire, no recovery");
    await fsp.rm(dir, { recursive: true, force: true });
  }

  console.log(`server.genlock.test.js — all ${passed} assertions passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
