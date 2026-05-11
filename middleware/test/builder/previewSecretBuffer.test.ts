import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { PreviewSecretBuffer } from '../../src/plugins/builder/previewSecretBuffer.js';
import { InMemorySecretVault } from '../../src/secrets/vault.js';

describe('PreviewSecretBuffer (in-memory mode)', () => {
  let buf: PreviewSecretBuffer;

  beforeEach(() => {
    buf = new PreviewSecretBuffer();
  });

  it('returns an empty object for unset entries', () => {
    assert.deepEqual(buf.get('a@x', 'd1'), {});
    assert.equal(buf.has('a@x', 'd1'), false);
  });

  it('stores and retrieves secret values per (user, draft)', async () => {
    await buf.set('a@x', 'd1', { ODOO_PASSWORD: 'p1', API_TOKEN: 't1' });
    assert.deepEqual(buf.get('a@x', 'd1'), {
      ODOO_PASSWORD: 'p1',
      API_TOKEN: 't1',
    });
    assert.equal(buf.has('a@x', 'd1'), true);
    assert.equal(buf.size(), 1);
  });

  it('returns a defensive copy — mutating the result must not change the buffer', async () => {
    await buf.set('a@x', 'd1', { K: 'v1' });
    const got = buf.get('a@x', 'd1') as Record<string, string>;
    got['K'] = 'mutated';
    assert.deepEqual(buf.get('a@x', 'd1'), { K: 'v1' });
  });

  it('takes a defensive copy on set — caller mutation post-set must not bleed in', async () => {
    const input: Record<string, string> = { K: 'v1' };
    await buf.set('a@x', 'd1', input);
    input['K'] = 'changed';
    input['NEW'] = 'never-stored';
    assert.deepEqual(buf.get('a@x', 'd1'), { K: 'v1' });
  });

  it('isolates secrets across users', async () => {
    await buf.set('alice@x', 'd1', { S: 'alice' });
    await buf.set('bob@x', 'd1', { S: 'bob' });
    assert.deepEqual(buf.get('alice@x', 'd1'), { S: 'alice' });
    assert.deepEqual(buf.get('bob@x', 'd1'), { S: 'bob' });
  });

  it('isolates secrets across drafts for the same user', async () => {
    await buf.set('a@x', 'd1', { S: '1' });
    await buf.set('a@x', 'd2', { S: '2' });
    assert.deepEqual(buf.get('a@x', 'd1'), { S: '1' });
    assert.deepEqual(buf.get('a@x', 'd2'), { S: '2' });
    assert.equal(buf.sizeForUser('a@x'), 2);
  });

  it('drop() removes a single (user, draft) entry', async () => {
    await buf.set('a@x', 'd1', { S: '1' });
    await buf.set('a@x', 'd2', { S: '2' });
    assert.equal(await buf.drop('a@x', 'd1'), true);
    assert.equal(buf.has('a@x', 'd1'), false);
    assert.equal(buf.has('a@x', 'd2'), true);
    assert.equal(buf.sizeForUser('a@x'), 1);
  });

  it('drop() returns false on missing entry', async () => {
    assert.equal(await buf.drop('a@x', 'never'), false);
  });

  it('dropAll(user) clears every draft for that user only', async () => {
    await buf.set('a@x', 'd1', { S: '1' });
    await buf.set('a@x', 'd2', { S: '2' });
    await buf.set('b@x', 'd3', { S: '3' });
    const cleared = await buf.dropAll('a@x');
    assert.equal(cleared, 2);
    assert.equal(buf.sizeForUser('a@x'), 0);
    assert.equal(buf.has('a@x', 'd1'), false);
    assert.equal(buf.has('b@x', 'd3'), true, 'other user untouched');
  });

  it('dropAll(user) returns 0 when user has no entries', async () => {
    assert.equal(await buf.dropAll('ghost@x'), 0);
  });

  it('clear() wipes every entry', async () => {
    await buf.set('a@x', 'd1', { S: '1' });
    await buf.set('b@x', 'd2', { S: '2' });
    buf.clear();
    assert.equal(buf.size(), 0);
    assert.equal(buf.has('a@x', 'd1'), false);
    assert.equal(buf.has('b@x', 'd2'), false);
  });

  it('replacing an existing entry does not duplicate the user-index slot', async () => {
    await buf.set('a@x', 'd1', { K: 'v1' });
    await buf.set('a@x', 'd1', { K: 'v2' });
    assert.equal(buf.sizeForUser('a@x'), 1);
    assert.deepEqual(buf.get('a@x', 'd1'), { K: 'v2' });
  });

  it('keys() returns the buffered key set without leaking values', async () => {
    await buf.set('a@x', 'd1', { API_KEY: 's3cr3t', SLUG: 'meetup-de' });
    const keys = buf.keys('a@x', 'd1');
    assert.deepEqual(keys.slice().sort(), ['API_KEY', 'SLUG']);
  });

  it('keys() returns an empty array when nothing is buffered', () => {
    assert.deepEqual(buf.keys('ghost@x', 'nope'), []);
  });

  it('persistent flag is false without a vault', () => {
    assert.equal(buf.persistent, false);
  });
});

describe('PreviewSecretBuffer (vault-backed mode)', () => {
  let vault: InMemorySecretVault;
  let buf: PreviewSecretBuffer;

  beforeEach(() => {
    vault = new InMemorySecretVault();
    buf = new PreviewSecretBuffer({ vault });
  });

  it('reports persistent=true when wired to a vault', () => {
    assert.equal(buf.persistent, true);
  });

  it('persists set values into the vault namespace', async () => {
    await buf.set('a@x', 'd1', { API_KEY: 'v1', SLUG: 's1' });
    const ns = 'core.builder-preview:a@x:d1';
    const keys = await vault.listKeys(ns);
    assert.deepEqual(keys.slice().sort(), ['API_KEY', 'SLUG']);
    assert.equal(await vault.get(ns, 'API_KEY'), 'v1');
    assert.equal(await vault.get(ns, 'SLUG'), 's1');
  });

  it('warm() populates the in-memory cache from the vault on a fresh buffer', async () => {
    // Simulate a previous run: write directly to the vault.
    await vault.set('core.builder-preview:a@x:d1', 'API_KEY', 'preserved');

    // Fresh buffer instance — same vault.
    const fresh = new PreviewSecretBuffer({ vault });
    assert.deepEqual(fresh.get('a@x', 'd1'), {});

    await fresh.warm('a@x', 'd1');
    assert.deepEqual(fresh.get('a@x', 'd1'), { API_KEY: 'preserved' });
    assert.deepEqual(fresh.keys('a@x', 'd1'), ['API_KEY']);
  });

  it('set() replaces vault contents — keys removed in JS are gone from vault too', async () => {
    await buf.set('a@x', 'd1', { A: '1', B: '2' });
    await buf.set('a@x', 'd1', { A: '1' });
    const ns = 'core.builder-preview:a@x:d1';
    const keys = await vault.listKeys(ns);
    assert.deepEqual(keys, ['A']);
  });

  it('drop() purges the vault namespace', async () => {
    await buf.set('a@x', 'd1', { A: '1' });
    await buf.drop('a@x', 'd1');
    const ns = 'core.builder-preview:a@x:d1';
    assert.deepEqual(await vault.listKeys(ns), []);
  });

  it('dropAll(user) purges every touched draft from the vault', async () => {
    await buf.set('a@x', 'd1', { A: '1' });
    await buf.set('a@x', 'd2', { A: '2' });
    await buf.dropAll('a@x');
    assert.deepEqual(
      await vault.listKeys('core.builder-preview:a@x:d1'),
      [],
    );
    assert.deepEqual(
      await vault.listKeys('core.builder-preview:a@x:d2'),
      [],
    );
  });

  it('warm() is idempotent — second call does not re-read the vault', async () => {
    await vault.set('core.builder-preview:a@x:d1', 'K', 'v');
    await buf.warm('a@x', 'd1');
    // Mutate the vault out-of-band.
    await vault.set('core.builder-preview:a@x:d1', 'K', 'tampered');
    // warm() should NOT pick up the tampered value because the buffer
    // already considers itself authoritative.
    await buf.warm('a@x', 'd1');
    assert.equal(buf.get('a@x', 'd1')['K'], 'v');
  });

  it('vaultPrefix is configurable for namespace isolation in tests', async () => {
    const altVault = new InMemorySecretVault();
    const altBuf = new PreviewSecretBuffer({
      vault: altVault,
      vaultPrefix: 'test.preview',
    });
    await altBuf.set('a@x', 'd1', { K: 'v' });
    assert.deepEqual(
      await altVault.listKeys('test.preview:a@x:d1'),
      ['K'],
    );
    assert.deepEqual(
      await altVault.listKeys('core.builder-preview:a@x:d1'),
      [],
    );
  });
});
