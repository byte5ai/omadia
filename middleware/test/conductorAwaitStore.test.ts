import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ConductorAwaitStore } from '../src/conductor/awaitStore.js';
import type { AwaitPrincipalKind } from '../src/conductor/awaitStore.js';

/**
 * Guards the operator-inbox query (`listWaiting`).
 *
 * Epic #470 C5 removed a channel-exclusion predicate from this query when the never-wired
 * Conductor job step it hid was deleted along with the only code that could ever have written
 * such a row. That made the inbox channel-agnostic, and this suite is what keeps it so:
 * `openHumanAwait` is now the single writer of `conductor_awaits`, so EVERY waiting await has a
 * human holder and belongs in the inbox regardless of which channel notifies that holder. A new
 * channel type must never have to register itself somewhere to become visible to an operator.
 *
 * #1712 is the other half: a `timer` principal (#330 C3) has NO holder, so it is not a human
 * await and must stay out of the inbox — it was rendered with Freigeben/Ablehnen buttons whose
 * respond call could only answer 403. Channel-agnostic, principal-aware.
 */
describe('ConductorAwaitStore.listWaiting — the operator inbox', () => {
  interface Row {
    id: string;
    run_id: string;
    step_id: string;
    principal_kind: AwaitPrincipalKind;
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

  function awaitRow(
    id: string,
    over: { channelType: string; status?: string; principalKind?: AwaitPrincipalKind; principalRef?: string },
  ): Row {
    const principalKind = over.principalKind ?? 'role';
    return {
      id,
      run_id: 'run1',
      step_id: id,
      principal_kind: principalKind,
      principal_ref: over.principalRef ?? (principalKind === 'timer' ? 'timer' : 'approvers'),
      channel_type: over.channelType,
      message: '',
      quorum: 'any',
      reminder_interval_ms: null,
      deadline_at: null,
      fallback_transition_id: null,
      status: over.status ?? 'waiting',
      unreachable: false,
      created_at: new Date(0),
    };
  }

  /** Behavioural fake Pool over an in-memory `conductor_awaits`. It applies the literal
   *  equality predicates of the query it is handed — parsed out of the SQL, not hard-coded
   *  per column — so adding, dropping or inverting a filter in the query under test really
   *  does change the result, and this fake never has to learn about a new column. */
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
          const predicates = [...sql.matchAll(/\b(?:a\.)?([a-z_]+)\s*(<>|=)\s*'([a-z_]+)'/g)];
          const out = rows.filter((row) =>
            predicates.every(([, column, op, value]) => {
              const cell = (row as unknown as Record<string, unknown>)[column!];
              return op === '=' ? cell === value : cell !== value;
            }),
          );
          return { rows: out, rowCount: out.length };
        },
      },
    };
  }

  it('returns every waiting await regardless of channel type', async () => {
    const { pool } = makePool([
      awaitRow('a1', { channelType: 'teams' }),
      awaitRow('a2', { channelType: 'telegram' }),
      awaitRow('a3', { channelType: 'web' }),
      // The literal this query used to exclude. Without a row carrying it, the
      // test cannot detect a `channel_type` exclusion filter being restored — it
      // would stay green against the exact regression it exists to catch.
      awaitRow('a4', { channelType: 'machine' }),
    ]);
    const store = new ConductorAwaitStore(pool as never);

    const inbox = await store.listWaiting();

    // FAIL-IF-REVERTED: any channel_type predicate in listWaiting drops a holder's await out of
    // the operator inbox, and the run it parks becomes invisible rather than actionable.
    assert.equal(inbox.length, 4);
    assert.deepEqual(
      inbox.map((a) => a.channelType).sort(),
      ['machine', 'teams', 'telegram', 'web'],
    );
  });

  it('keeps timer awaits out of the inbox — a tick has no holder to answer it (#1712)', async () => {
    const { pool } = makePool([
      awaitRow('a1', { channelType: 'teams' }),
      awaitRow('a2', { channelType: 'timer', principalKind: 'timer' }),
      awaitRow('a3', { channelType: 'web', principalKind: 'user' }),
    ]);
    const store = new ConductorAwaitStore(pool as never);

    const inbox = await store.listWaiting();

    // FAIL-IF-REVERTED: a listed timer await gets Freigeben/Ablehnen buttons in the web UI,
    // and POST /awaits/:id/respond can only answer 403 (no holder to be the responder).
    assert.deepEqual(inbox.map((a) => a.id), ['a1', 'a3']);
  });

  it('excludes the timer PRINCIPAL, not the timer channel (#1712)', async () => {
    // A human await notified over a channel that happens to be called 'timer' is still a
    // human await: what disqualifies a row is having nobody to ask.
    const { pool } = makePool([awaitRow('a1', { channelType: 'timer', principalKind: 'role' })]);
    const store = new ConductorAwaitStore(pool as never);

    assert.deepEqual((await store.listWaiting()).map((a) => a.id), ['a1']);
  });

  it('still filters on status — only waiting awaits reach the inbox', async () => {
    const { pool } = makePool([
      awaitRow('a1', { channelType: 'teams' }),
      awaitRow('a2', { channelType: 'teams', status: 'resolved' }),
      awaitRow('a3', { channelType: 'teams', status: 'cancelled' }),
    ]);
    const store = new ConductorAwaitStore(pool as never);

    const inbox = await store.listWaiting();

    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]!.id, 'a1');
    assert.equal(inbox[0]!.status, 'waiting');
  });

  it('clamps the caller-supplied limit into the supported range', async () => {
    const { pool, params } = makePool([awaitRow('a1', { channelType: 'teams' })]);
    const store = new ConductorAwaitStore(pool as never);

    await store.listWaiting(10_000); // above the cap
    await store.listWaiting(0); // below the floor

    assert.equal(params[0]![0], 500);
    assert.equal(params[1]![0], 1);
  });
});
