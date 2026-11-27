#!/usr/bin/env node
/**
 * Memory-ACL plan step 6 — run test files in parallel and stop at the first
 * red one. The test command of the nightly Stryker run
 * (`stryker.memory-acl.config.mjs`): Stryker's command runner only reads the exit
 * code, and `node --test` has no bail, so without this a mutant the first
 * file catches would still wait for every other file.
 *
 *   node scripts/mutation/runUntilRed.mjs [--width N] <test file>...
 *
 * Exit 0: every file passed. Exit 1: a file failed (named on stderr); the
 * files still running are killed.
 */
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
let width = 4;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--width') width = Number(args[++i]);
  else files.push(args[i]);
}
if (files.length === 0 || !Number.isInteger(width) || width < 1) {
  console.error('usage: runUntilRed.mjs [--width N] <test file>...');
  process.exit(2);
}

const live = new Set();
let failed = false;

function killAll() {
  for (const child of live) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--test', '--test-timeout=120000', '--test-reporter=dot', file],
      { detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: process.env },
    );
    live.add(child);
    child.on('close', (code) => {
      live.delete(child);
      resolve(code === 0);
    });
  });
}

const queue = [...files];
async function worker() {
  while (!failed && queue.length > 0) {
    const file = queue.shift();
    if (!(await run(file)) && !failed) {
      failed = true;
      console.error(`red: ${file}`);
      killAll();
    }
  }
}
await Promise.all(Array.from({ length: Math.min(width, files.length) }, worker));
process.exit(failed ? 1 : 0);
