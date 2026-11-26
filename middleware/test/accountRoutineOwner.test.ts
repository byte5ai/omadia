import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { routineOwnerIdsForAccount } from '../src/plugins/routines/accountRoutineOwner.js';

/** #1765 — an account resolves to the ids its routines are filed under. */
describe('routineOwnerIdsForAccount', () => {
  const pool = (row: { omadia_user_id: string | null; other_web_logins: string } | undefined) => ({
    calls: [] as unknown[][],
    query(_sql: string, params: unknown[]) {
      this.calls.push(params);
      return Promise.resolve({ rows: row ? [row] : [] });
    },
  });

  it('adds the person\'s omadia user id when this is their only web login', async () => {
    const p = pool({ omadia_user_id: 'cluster-1', other_web_logins: '0' });
    assert.deepEqual(await routineOwnerIdsForAccount(p as never, 't', 'u-1'), ['u-1', 'cluster-1']);
    assert.deepEqual(p.calls[0], ['t', 'web:u-1']);
  });

  it('keeps the person\'s routines when another web login remains', async () => {
    const p = pool({ omadia_user_id: 'cluster-1', other_web_logins: '1' });
    assert.deepEqual(await routineOwnerIdsForAccount(p as never, 't', 'u-1'), ['u-1']);
  });

  it('falls back to users.id alone when the graph knows no identity', async () => {
    assert.deepEqual(await routineOwnerIdsForAccount(pool(undefined) as never, 't', 'u-1'), ['u-1']);
  });
});
