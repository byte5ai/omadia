import { describe, it, afterEach, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { FileSecretVault } from '../src/secrets/fileVault.js';

/**
 * F11 — `persist()` snapshots the in-memory map, then crosses three `await`
 * points (mkdir → encrypt/write tmp → rename) with no mutex. Two interleaved
 * writers could therefore rename a STALE snapshot last, silently dropping the
 * other write on disk. Memory stayed correct, so the loss only became visible
 * after a restart — the worst possible failure mode for a credential store.
 *
 * The race is real but timing-dependent, so these tests make the interleaving
 * DETERMINISTIC by slowing the first `writeFile` down. `fileVault` does
 * `import { promises as fs }` and then calls `fs.writeFile(...)` — a property
 * lookup on the shared `node:fs` promises object at call time — so patching the
 * property here is genuinely observed by the module under test.
 */

const realWriteFile = fsp.writeFile.bind(fsp);
let slowFirstWrite = false;
let writeCalls = 0;

async function makeVault(dir: string): Promise<FileSecretVault> {
  const v = new FileSecretVault(
    path.join(dir, 'vault.enc.json'),
    KEY,
  );
  await v.load();
  return v;
}

const KEY = crypto.createHash('sha256').update('f11-test-key').digest();

describe('F11 — concurrent vault writes must not lose an update on disk', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'omadia-vault-f11-'));
    writeCalls = 0;
    slowFirstWrite = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fsp as any).writeFile = async (...args: unknown[]): Promise<unknown> => {
      const isFirst = writeCalls === 0;
      writeCalls += 1;
      if (slowFirstWrite && isFirst) await sleep(80);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return realWriteFile(...(args as [any, any, any]));
    };
  });

  afterEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fsp as any).writeFile = realWriteFile;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('a slow write cannot rename a stale snapshot over a newer one', async () => {
    const vault = await makeVault(dir);
    slowFirstWrite = true;

    // Writer A snapshots `{k1}` and is then parked inside its (slow) writeFile.
    const a = vault.set('agent', 'k1', 'v1');
    await sleep(10);
    // Writer B lands completely while A is still in flight, then A renames.
    const b = vault.set('agent', 'k2', 'v2');
    await Promise.all([a, b]);

    // Reload from DISK — the in-memory map has always looked correct, which is
    // exactly what made this bug survive.
    const reloaded = await makeVault(dir);
    assert.deepEqual(
      (await reloaded.listKeys('agent')).sort(),
      ['k1', 'k2'],
      'a concurrent write was lost on disk',
    );
  });

  it('a delete interleaved with a write survives a reload', async () => {
    const seed = await makeVault(dir);
    await seed.set('agent', 'keep', 'v');
    await seed.set('agent', 'drop', 'v');

    slowFirstWrite = true;
    writeCalls = 0;
    const del = seed.deleteKey('agent', 'drop');
    await sleep(10);
    const add = seed.set('agent', 'added', 'v');
    await Promise.all([del, add]);

    const reloaded = await makeVault(dir);
    assert.deepEqual(
      (await reloaded.listKeys('agent')).sort(),
      ['added', 'keep'],
      'disk state diverged from memory after interleaved delete/write',
    );
  });

  it('many interleaved writes all land', async () => {
    const vault = await makeVault(dir);
    const keys = Array.from({ length: 25 }, (_, i) => `k${String(i)}`);
    await Promise.all(keys.map((k) => vault.set('agent', k, 'v')));

    const reloaded = await makeVault(dir);
    assert.equal((await reloaded.listKeys('agent')).length, keys.length);
  });

  it('a failed write does not poison every later write', async () => {
    // The serialising chain must not stay rejected — one ENOSPC would
    // otherwise permanently break the vault for the life of the process.
    const vault = await makeVault(dir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fsp as any).writeFile = async (): Promise<never> => {
      throw new Error('boom');
    };
    await assert.rejects(vault.set('agent', 'x', 'v'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fsp as any).writeFile = realWriteFile;
    await vault.set('agent', 'y', 'v');
    const reloaded = await makeVault(dir);
    assert.ok((await reloaded.listKeys('agent')).includes('y'));
  });
});
