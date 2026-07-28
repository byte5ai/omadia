import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createApiKeyStore } from '../../packages/harness-channel-api/src/apiKeyStore.js';
import { createFakeSecrets } from './testSecrets.js';

describe('channelApi/apiKeyStore', () => {
  it('create() returns a plaintext token once and a public record without the hash', async () => {
    const store = createApiKeyStore(createFakeSecrets());
    const created = await store.create({ label: 'ci-bot' });
    assert.ok(created.token.startsWith('omk_'));
    assert.equal(created.record.label, 'ci-bot');
    assert.equal(created.record.rateLimitPerMinute, 60, 'defaults to 60/min');
    assert.equal(created.record.revokedAt, undefined);
    assert.ok(!('hash' in created.record), 'public view never carries the hash');
  });

  it('honours a custom rateLimitPerMinute', async () => {
    const store = createApiKeyStore(createFakeSecrets());
    const created = await store.create({ rateLimitPerMinute: 5 });
    assert.equal(created.record.rateLimitPerMinute, 5);
  });

  it('list() returns every created key, oldest first, without hashes', async () => {
    const store = createApiKeyStore(createFakeSecrets());
    const a = await store.create({ label: 'a' });
    const b = await store.create({ label: 'b' });
    const listed = await store.list();
    assert.deepEqual(
      listed.map((k) => k.label),
      ['a', 'b'],
    );
    assert.ok(listed.every((k) => !('hash' in k)));
    assert.ok(listed.some((k) => k.id === a.record.id));
    assert.ok(listed.some((k) => k.id === b.record.id));
  });

  it('verify() resolves a valid, non-revoked key to its record', async () => {
    const store = createApiKeyStore(createFakeSecrets());
    const created = await store.create({});
    const resolved = await store.verify(created.token);
    assert.ok(resolved);
    assert.equal(resolved?.id, created.record.id);
  });

  it('verify() rejects an unknown token', async () => {
    const store = createApiKeyStore(createFakeSecrets());
    await store.create({});
    const resolved = await store.verify('omk_not-a-real-key');
    assert.equal(resolved, undefined);
  });

  it('revoke() makes the key stop authenticating on the next verify() call', async () => {
    const store = createApiKeyStore(createFakeSecrets());
    const created = await store.create({});
    assert.ok(await store.verify(created.token), 'valid before revoke');

    const revoked = await store.revoke(created.record.id);
    assert.ok(revoked);
    assert.ok(typeof revoked?.revokedAt === 'number');

    const resolved = await store.verify(created.token);
    assert.equal(resolved, undefined, 'revoked key must no longer authenticate');
  });

  it('revoke() is idempotent and revoke() of an unknown id returns undefined', async () => {
    const store = createApiKeyStore(createFakeSecrets());
    const created = await store.create({});
    const first = await store.revoke(created.record.id);
    const second = await store.revoke(created.record.id);
    assert.equal(first?.revokedAt, second?.revokedAt, 'revoking twice does not bump revokedAt');
    assert.equal(await store.revoke('does-not-exist'), undefined);
  });

  it('two keys are independently verifiable and independently revocable', async () => {
    const store = createApiKeyStore(createFakeSecrets());
    const a = await store.create({ label: 'a' });
    const b = await store.create({ label: 'b' });
    await store.revoke(a.record.id);
    assert.equal(await store.verify(a.token), undefined, 'a is revoked');
    assert.ok(await store.verify(b.token), 'b is untouched');
  });
});
