import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { MAX_ENTRIES, createAuditLog } from '../../packages/harness-api-key-auth/src/auditLog.js';
import { createFakeSecrets } from './testSecrets.js';

describe('channelApi/auditLog', () => {
  it('record() then list() surfaces the entry (who called what, when)', async () => {
    const log = createAuditLog(createFakeSecrets());
    await log.record({ keyId: 'k1', route: '/chat', method: 'POST', at: 1000, status: 'ok' });
    const entries = await log.list();
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], {
      keyId: 'k1',
      route: '/chat',
      method: 'POST',
      at: 1000,
      status: 'ok',
    });
  });

  it('concurrent record() calls do not lose entries (serialized writes)', async () => {
    const log = createAuditLog(createFakeSecrets());
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        log.record({ keyId: `k${i}`, route: '/chat', method: 'POST', at: i, status: 'ok' }),
      ),
    );
    const entries = await log.list();
    assert.equal(entries.length, N, 'no entry lost to a read-modify-write race');
    const keyIds = new Set(entries.map((e) => e.keyId));
    assert.equal(keyIds.size, N, 'every distinct call is represented');
  });

  it('caps the log at MAX_ENTRIES, dropping the oldest first', async () => {
    const log = createAuditLog(createFakeSecrets());
    for (let i = 0; i < MAX_ENTRIES + 10; i++) {
      await log.record({ keyId: 'k1', route: '/chat', method: 'POST', at: i, status: 'ok' });
    }
    const entries = await log.list();
    assert.equal(entries.length, MAX_ENTRIES);
    assert.equal(entries[0]?.at, 10, 'the oldest 10 entries were dropped');
    assert.equal(entries[entries.length - 1]?.at, MAX_ENTRIES + 9);
  });
});
