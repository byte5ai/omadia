/**
 * #1080 — the concrete vaults announce every completed write, so the kernel
 * can drop caches derived from credentials (provider pool, shared client).
 */

import { describe, it, afterEach, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { FileSecretVault } from '../src/secrets/fileVault.js';
import {
  InMemorySecretVault,
  type SecretVaultWriteEvent,
} from '../src/secrets/vault.js';

const KEY = crypto.createHash('sha256').update('1080-test-key').digest();
const realWriteFile = fsp.writeFile.bind(fsp);

type ObservableVault = FileSecretVault | InMemorySecretVault;

function record(vault: ObservableVault): SecretVaultWriteEvent[] {
  const events: SecretVaultWriteEvent[] = [];
  vault.onWrite((e) => events.push(e));
  return events;
}

const variants: Array<{
  name: string;
  make: (dir: string) => Promise<ObservableVault>;
}> = [
  {
    name: 'FileSecretVault',
    make: async (dir) => {
      const v = new FileSecretVault(path.join(dir, 'vault.enc.json'), KEY);
      await v.load();
      return v;
    },
  },
  { name: 'InMemorySecretVault', make: async () => new InMemorySecretVault() },
];

for (const variant of variants) {
  describe(`#1080 — ${variant.name} write events`, () => {
    let dir = '';

    beforeEach(async () => {
      dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'omadia-vault-1080-'));
    });

    afterEach(async () => {
      await fsp.rm(dir, { recursive: true, force: true });
    });

    it('set, setMany and deleteKey emit the touched keys; purge emits purged', async () => {
      const vault = await variant.make(dir);
      const events = record(vault);
      await vault.set('@omadia/orchestrator', 'a', '1');
      await vault.setMany('@omadia/orchestrator', { b: '2', c: '3' });
      await vault.deleteKey('@omadia/orchestrator', 'a');
      await vault.purge('@omadia/orchestrator');
      assert.deepEqual(events, [
        { scope: '@omadia/orchestrator', keys: ['a'] },
        { scope: '@omadia/orchestrator', keys: ['b', 'c'] },
        { scope: '@omadia/orchestrator', keys: ['a'] },
        { scope: '@omadia/orchestrator', purged: true },
      ]);
    });

    it('a no-op delete and an empty setMany emit nothing', async () => {
      const vault = await variant.make(dir);
      await vault.set('s', 'present', 'x');
      const events = record(vault);
      await vault.deleteKey('s', 'absent');
      await vault.deleteKey('unknown-scope', 'absent');
      await vault.setMany('s', {});
      assert.deepEqual(events, []);
    });

    it('the event fires before the write promise settles', async () => {
      const vault = await variant.make(dir);
      let seen = false;
      vault.onWrite(() => {
        seen = true;
      });
      await vault.set('s', 'k', 'v');
      assert.equal(seen, true);
    });

    it('a throwing listener neither fails the write nor starves other listeners', async () => {
      const vault = await variant.make(dir);
      vault.onWrite(() => {
        throw new Error('boom');
      });
      const events = record(vault);
      await vault.set('s', 'k', 'v');
      assert.equal(await vault.get('s', 'k'), 'v');
      assert.equal(events.length, 1);
    });

    it('unsubscribe stops delivery', async () => {
      const vault = await variant.make(dir);
      const events: SecretVaultWriteEvent[] = [];
      const off = vault.onWrite((e) => events.push(e));
      await vault.set('s', 'k', '1');
      off();
      await vault.set('s', 'k', '2');
      assert.equal(events.length, 1);
    });
  });
}

describe('#1080 — FileSecretVault emits even when persisting fails', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'omadia-vault-1080-'));
  });

  afterEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fsp as any).writeFile = realWriteFile;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('the in-memory map already changed, so derived caches must still drop', async () => {
    const vault = new FileSecretVault(path.join(dir, 'vault.enc.json'), KEY);
    await vault.load();
    const events = record(vault);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fsp as any).writeFile = async (): Promise<never> => {
      throw new Error('disk full');
    };
    await assert.rejects(vault.set('@omadia/orchestrator', 'k', 'v'), /disk full/);
    assert.equal(await vault.get('@omadia/orchestrator', 'k'), 'v');
    assert.deepEqual(events, [{ scope: '@omadia/orchestrator', keys: ['k'] }]);
  });
});
