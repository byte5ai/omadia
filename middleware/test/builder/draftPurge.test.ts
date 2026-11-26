import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { purgeDeletedDrafts } from '../../src/plugins/builder/draftPurge.js';

/** #1790 — a purged draft takes its test credentials with it. */
describe('purgeDeletedDrafts', () => {
  it('drops the test credentials of every purged draft', async () => {
    const dropped: string[] = [];
    const n = await purgeDeletedDrafts({
      draftStore: {
        purgePublished: async () => [
          { id: 'd1', userEmail: 'a@x' },
          { id: 'd2', userEmail: 'b@x' },
        ],
      },
      previewSecretBuffer: {
        drop: async (u: string, d: string) => {
          dropped.push(`${u}/${d}`);
          return true;
        },
      },
    });
    assert.equal(n, 2);
    assert.deepEqual(dropped, ['a@x/d1', 'b@x/d2']);
  });

  it('a failing vault drop does not stop the others', async () => {
    const dropped: string[] = [];
    const lines: string[] = [];
    await purgeDeletedDrafts({
      draftStore: {
        purgePublished: async () => [
          { id: 'd1', userEmail: 'a@x' },
          { id: 'd2', userEmail: 'a@x' },
        ],
      },
      previewSecretBuffer: {
        drop: async (_u: string, d: string) => {
          if (d === 'd1') throw new Error('vault down');
          dropped.push(d);
          return true;
        },
      },
      log: (l) => lines.push(l),
    });
    assert.deepEqual(dropped, ['d2']);
    assert.ok(lines.some((l) => l.includes('d1') && l.includes('vault down')));
  });
});
