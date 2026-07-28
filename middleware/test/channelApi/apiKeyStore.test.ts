import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { hasScope } from '../../packages/harness-api-key-auth/src/apiKeyScopes.js';
import { createApiKeyStore } from '../../packages/harness-api-key-auth/src/apiKeyStore.js';
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

/** Issue #439 — per-key scopes, with the backward-compat contract for keys
 *  written to the vault before the field existed. */
describe('channelApi/apiKeyStore — scopes', () => {
  it('defaults to the legacy scope set when none is given, and exposes it on create/list', async () => {
    const store = createApiKeyStore(createFakeSecrets());
    const created = await store.create({ label: 'default-scoped' });
    assert.deepEqual(created.record.scopes, ['chat:write']);
    const listed = await store.list();
    assert.deepEqual(listed[0]?.scopes, ['chat:write']);
  });

  it('persists an explicit scope set and returns it on verify()', async () => {
    const store = createApiKeyStore(createFakeSecrets());
    const created = await store.create({ scopes: ['memory:read', 'chat:write'] });
    assert.deepEqual(created.record.scopes, ['memory:read', 'chat:write']);
    const resolved = await store.verify(created.token);
    assert.deepEqual(resolved?.scopes, ['memory:read', 'chat:write']);
  });

  it('treats an explicitly empty scope array at CREATE time as "unspecified", and persists the resolved set explicitly', async () => {
    // Not a silent grant: the create result echoes the scope set that was
    // actually assigned, and the vault entry holds it verbatim — which is
    // what keeps "no scopes field at all" meaning "pre-#439" on read.
    const store = createApiKeyStore(createFakeSecrets());
    const created = await store.create({ scopes: [] });
    assert.deepEqual(created.record.scopes, ['chat:write']);
    assert.deepEqual((await store.verify(created.token))?.scopes, ['chat:write']);
  });

  it('rejects a malformed scope rather than silently dropping it', async () => {
    const store = createApiKeyStore(createFakeSecrets());
    await assert.rejects(() => store.create({ scopes: ['not a scope'] }), /invalid API-key scope/);
  });

  it('a key persisted BEFORE scopes existed still authenticates, with the legacy scope set', async () => {
    // Exactly the JSON shape issue #438 wrote: no `scopes` field at all.
    const secrets = createFakeSecrets();
    const store = createApiKeyStore(secrets);
    const legacy = await store.create({ label: 'pre-scopes' });
    const raw = await secrets.get(`key:${legacy.record.id}`);
    assert.ok(raw);
    const { scopes: _dropped, ...withoutScopes } = JSON.parse(raw) as Record<string, unknown>;
    await secrets.set?.(`key:${legacy.record.id}`, JSON.stringify(withoutScopes));

    const resolved = await store.verify(legacy.token);
    assert.ok(resolved, 'a pre-scopes key must keep authenticating');
    assert.deepEqual(resolved?.scopes, ['chat:write']);
    assert.deepEqual((await store.list())[0]?.scopes, ['chat:write']);
  });

  it('a key whose persisted scopes field is MALFORMED authenticates but is authorized for nothing', async () => {
    // The fail-open this replaced: a `scopes` field that is present and
    // unreadable used to hydrate to the legacy default, so a key an operator
    // had restricted away from chat came back chat-capable. Absent means
    // "pre-#439"; malformed means "we cannot tell", and we must not guess in
    // the direction of a grant.
    for (const corrupt of ['memory:read', ['Chat:Write'], [], ['chat:write', 'nonsense'], null]) {
      const secrets = createFakeSecrets();
      const store = createApiKeyStore(secrets);
      const key = await store.create({ label: 'restricted', scopes: ['memory:read'] });
      const raw = await secrets.get(`key:${key.record.id}`);
      assert.ok(raw);
      const record = JSON.parse(raw) as Record<string, unknown>;
      await secrets.set?.(
        `key:${key.record.id}`,
        JSON.stringify({ ...record, scopes: corrupt }),
      );

      const resolved = await store.verify(key.token);
      assert.ok(resolved, 'the credential itself is still valid — only its authorization is gone');
      assert.deepEqual(resolved?.scopes, [], `scopes=${JSON.stringify(corrupt)} must grant nothing`);
      assert.equal(hasScope(resolved?.scopes, 'chat:write'), false);
      assert.equal(hasScope(resolved?.scopes, 'memory:read'), false);
    }
  });
});
