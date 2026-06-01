import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { planNodeId } from '@omadia/plugin-api';

// #133 (E6/E7) — listPlansForScope: scope-keyed plan lookup powering the
// graph-view plan overlay + verifier-replan.

describe('#133 — listPlansForScope', () => {
  it('returns a scope’s plans most-recent first; isolates by scope', async () => {
    const kg = new InMemoryKnowledgeGraph();
    await kg.ingestPlan({
      planId: 'p-old',
      scope: 'sess-A',
      createdAt: '2026-06-01T10:00:00.000Z',
    });
    await kg.ingestPlan({
      planId: 'p-new',
      scope: 'sess-A',
      createdAt: '2026-06-01T11:00:00.000Z',
    });
    await kg.ingestPlan({
      planId: 'p-other',
      scope: 'sess-B',
      createdAt: '2026-06-01T10:30:00.000Z',
    });

    const a = await kg.listPlansForScope('sess-A');
    assert.equal(a.length, 2);
    assert.equal(a[0]!.id, planNodeId('p-new')); // most recent first
    assert.equal(a[1]!.id, planNodeId('p-old'));
    assert.ok(a.every((n) => n.type === 'Plan'));

    const b = await kg.listPlansForScope('sess-B');
    assert.equal(b.length, 1);
    assert.equal(b[0]!.id, planNodeId('p-other'));

    assert.deepEqual(await kg.listPlansForScope('sess-none'), []);
  });
});
