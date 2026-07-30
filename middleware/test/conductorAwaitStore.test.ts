import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ConductorAwaitStore } from '../src/conductor/awaitStore.js';

/**
 * Guards the operator-inbox query (`listWaiting`).
 *
 * Epic #470 C5 removed a channel-exclusion predicate from this query when the never-wired
 * Conductor job step it hid was deleted along with the only code that could ever have written
 * such a row. That made the inbox channel-agnostic, and this suite is what keeps it so:
 * `openHumanAwait` is now the single writer of `conductor_awaits`, so EVERY waiting await has a
 * human holder and belongs in the inbox regardless of which channel notifies that holder. A new
 * channel type must never have to register itself somewhere to become visible to an operator.
 */
describe('ConductorAwaitStore.listWaiting — the operator inbox', () => {
  interface Row {
    id: string;
    run_id: string;
    step_id: string;
    principal_kind: 'user' | 'role';
    principal_ref: string;
    channel_type: string;
    message: string;
    quorum: 'any' | 'all';
    reminder_interval_ms: string | null;
    deadline_at: Date | null;
    fallback_transition_id: string | null;
    status: string;
    unreachable: boolean;
    created_at: Date;
  }

  function awaitRow(id: string, channelType: string, status = 'waiting'): Row {
    return {
      id,
      run_id: 'run1',
      step_id: id,
      principal_kind: 'role',
      principal_ref: 'approvers',
      channel_type: channelType,
      message: '',
      quorum: 'any',
      reminder_interval_ms: null,
      deadline_at: null,
      fallback_transition_id: null,
      status,
      unreachable: false,
      created_at: new Date(0),
    };
  }

  /** Behavioural fake Pool over an in-memory `conductor_awaits`: it applies the query's OWN
   *  predicates, so re-introducing a channel filter in the SQL really does change the result. */
  function makePool(rows: Row[]) {
    const seen: string[] = [];
    const params: unknown[][] = [];
    return {
      seen,
      params,
      pool: {
        async query(sql: string, args: unknown[] = []) {
          seen.push(sql);
          params.push(args);
          let out = rows;
          if (/status\s*=\s*'waiting'/.test(sql)) out = out.filter((r) => r.status === 'waiting');
          const excluded = /channel_type\s*<>\s*'([a-z_]+)'/.exec(sql);
          if (excluded) out = out.filter((r) => r.channel_type !== excluded[1]);
          const only = /channel_type\s*=\s*'([a-z_]+)'/.exec(sql);
          if (only) out = out.filter((r) => r.channel_type === only[1]);
          return { rows: out, rowCount: out.length };
        },
      },
    };
  }

  it('returns every waiting await regardless of channel type', async () => {
    const { pool } = makePool([
      awaitRow('a1', 'teams'),
      awaitRow('a2', 'telegram'),
      awaitRow('a3', 'web'),
      // The literal this query used to exclude. Without a row carrying it, the
      // test cannot detect `AND channel_type <> 'dev_job'` being restored — it
      // would stay green against the exact regression it exists to catch.
      awaitRow('a4', 'dev_job'),
    ]);
    const store = new ConductorAwaitStore(pool as never);

    const inbox = await store.listWaiting();

    // FAIL-IF-REVERTED: any channel_type predicate in listWaiting drops a holder's await out of
    // the operator inbox, and the run it parks becomes invisible rather than actionable.
    assert.equal(inbox.length, 4);
    assert.deepEqual(
      inbox.map((a) => a.channelType).sort(),
      ['dev_job', 'teams', 'telegram', 'web'],
    );
  });

  it('still filters on status — only waiting awaits reach the inbox', async () => {
    const { pool } = makePool([
      awaitRow('a1', 'teams'),
      awaitRow('a2', 'teams', 'resolved'),
      awaitRow('a3', 'teams', 'cancelled'),
    ]);
    const store = new ConductorAwaitStore(pool as never);

    const inbox = await store.listWaiting();

    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]!.id, 'a1');
    assert.equal(inbox[0]!.status, 'waiting');
  });

  it('clamps the caller-supplied limit into the supported range', async () => {
    const { pool, params } = makePool([awaitRow('a1', 'teams')]);
    const store = new ConductorAwaitStore(pool as never);

    await store.listWaiting(10_000); // above the cap
    await store.listWaiting(0); // below the floor

    assert.equal(params[0]![0], 500);
    assert.equal(params[1]![0], 1);
  });
});
