/**
 * `RequestTurnRecord` — the one record of a request that ran in several
 * passes (commit-on-delivery). Unit level; the end-to-end behaviour under
 * `VerifierService` is in `verifierDeliveredTurnRecord.test.ts`. All values
 * are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { EntityRef } from '@omadia/plugin-api';

import { RequestTurnRecord } from '../packages/harness-orchestrator/src/requestTurnRecord.js';
import { turnContext } from '../packages/harness-orchestrator/src/turnContext.js';

const ref = (id: number): EntityRef => ({ system: 'odoo', model: 'account.move', id, op: 'read' });

interface Written {
  readonly pass: number;
  readonly entityRefs: EntityRef[];
  readonly inTurn: string | undefined;
}

function draft(pass: number, written: Written[], entityRefs: EntityRef[] = []) {
  return {
    entityRefs,
    write: (refs: EntityRef[]) => {
      written.push({ pass, entityRefs: refs, inTurn: turnContext.currentTurnId() });
      return Promise.resolve({ turnId: `turn:${String(pass)}` });
    },
  };
}

describe('RequestTurnRecord', () => {
  it('writes the committed pass once, with the entities of every pass', async () => {
    const record = new RequestTurnRecord();
    const written: Written[] = [];
    record.offer(0, draft(0, written, [ref(1)]));
    record.offer(1, draft(1, written, [ref(2)]));

    const first = await record.commit(1);
    const again = await record.commit(0);

    assert.deepEqual(written.map((w) => w.pass), [1], 'one row, of the committed pass');
    assert.deepEqual(written[0]?.entityRefs, [ref(1), ref(2)]);
    assert.equal(first.turnId, 'turn:1');
    assert.deepEqual(again, first, 'a later commit returns the first outcome');
  });

  it('fires the request’s onAfterTurn once, with the committed pass’s answer and row', async () => {
    const record = new RequestTurnRecord();
    const calls: Array<[string, string | undefined]> = [];
    const event = { type: 'turn_annotation', channel: 'plan', payload: {} } as const;
    record.bindAfterTurn((answer, turnExternalId) => {
      calls.push([answer, turnExternalId]);
      return Promise.resolve([event]);
    });
    record.bindAfterTurn(() => Promise.reject(new Error('a later binding never runs')));
    record.offer(0, draft(0, []));
    record.offer(1, draft(1, []));
    record.noteAnswer(0, 'erste Antwort');
    record.noteAnswer(1, 'korrigierte Antwort');

    const committed = await record.commit(1);

    assert.deepEqual(calls, [['korrigierte Antwort', 'turn:1']]);
    assert.deepEqual(committed.events, [event]);
  });

  it('a pass that offered no row writes none; whenCommitted resolves on any commit', async () => {
    const record = new RequestTurnRecord();
    const written: Written[] = [];
    record.offer(0, draft(0, written));
    let settled = false;
    void record.whenCommitted().then(() => {
      settled = true;
    });

    const committed = await record.commit(2);
    await Promise.resolve();

    assert.deepEqual(written, []);
    assert.equal(committed.turnId, undefined);
    assert.equal(settled, true);
  });

  it('a failing write is reported, never thrown', async () => {
    const record = new RequestTurnRecord();
    record.offer(0, { entityRefs: [], write: () => Promise.reject(new Error('store down')) });

    const committed = await record.commit(0);

    assert.deepEqual(committed, { events: [] });
  });

  it('writes in the async context of the offering pass, not the committer’s', async () => {
    const record = new RequestTurnRecord();
    const written: Written[] = [];
    await turnContext.run({ turnId: 'turn-pass-1', turnDate: '2026-10-01' }, () => {
      record.offer(1, draft(1, written));
      return Promise.resolve();
    });

    await turnContext.run({ turnId: 'turn-committer', turnDate: '2026-10-01' }, () =>
      record.commit(1),
    );

    assert.equal(written[0]?.inTurn, 'turn-pass-1');
  });
});
