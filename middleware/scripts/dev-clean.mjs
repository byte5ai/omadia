#!/usr/bin/env node
// dev-clean — terminate stale `tsx watch src/index.ts` middleware-dev processes
// and verify port :3979 is free, so a subsequent `npm run dev` boots cleanly.
//
// Idempotent: if nothing is running, it logs "no stale dev processes" and exits 0.
//
// Saga reference: HANDOFF-2026-05-04 (zombie-tsx on :3979 holding old
// boilerplate code while hot-reload silently piped new code into a process
// that never managed to bind the port).

import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.PORT ?? 3979);
const PATTERN = 'tsx.*src/index.ts';

/** Run a shell command, return stdout (trimmed) or '' on non-zero exit. */
function shell(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Find PIDs of dev-tsx processes. Returns string[] (may be empty). */
function findDevPids() {
  const out = shell(`pgrep -f '${PATTERN}'`);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** Find PID(s) holding LISTEN on PORT. Returns string[] (may be empty). */
function findPortHolders() {
  const out = shell(`lsof -ti tcp:${PORT} -sTCP:LISTEN`);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** Send signal to PIDs. Logs each one. Skips already-dead. */
function killPids(pids, signal) {
  for (const pid of pids) {
    try {
      process.kill(Number(pid), signal);
      console.log(`[dev-clean] sent ${signal} to PID ${pid}`);
    } catch (err) {
      if (err && err.code === 'ESRCH') continue; // already gone
      console.log(`[dev-clean] kill ${pid} failed: ${err?.message ?? err}`);
    }
  }
}

async function main() {
  const devPids = findDevPids();
  const portPids = findPortHolders();
  const targets = Array.from(new Set([...devPids, ...portPids]));

  if (targets.length === 0) {
    console.log('[dev-clean] no stale dev processes; port :' + PORT + ' free');
    return;
  }

  console.log(`[dev-clean] found ${targets.length} stale process(es): ${targets.join(', ')}`);
  killPids(targets, 'SIGTERM');

  // Give graceful shutdown a moment.
  await sleep(1000);

  const stillHolding = findPortHolders();
  if (stillHolding.length > 0) {
    console.log(`[dev-clean] port still held by: ${stillHolding.join(', ')} — escalating to SIGKILL`);
    killPids(stillHolding, 'SIGKILL');
    await sleep(500);
  }

  // Also SIGKILL any tsx-pids that survived SIGTERM (e.g. blocking on long
  // shutdown hooks like the Telegram long-poll cycle).
  const stragglerDevPids = findDevPids();
  if (stragglerDevPids.length > 0) {
    console.log(`[dev-clean] tsx still alive: ${stragglerDevPids.join(', ')} — escalating to SIGKILL`);
    killPids(stragglerDevPids, 'SIGKILL');
    await sleep(500);
  }

  const finalHolders = findPortHolders();
  if (finalHolders.length > 0) {
    console.error(`[dev-clean] FAILED: port :${PORT} still held by ${finalHolders.join(', ')}`);
    process.exit(2);
  }

  console.log(`[dev-clean] port :${PORT} free`);
}

main().catch((err) => {
  console.error('[dev-clean] unexpected error:', err);
  process.exit(1);
});
