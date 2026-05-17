import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { routineTurnContext } from '../src/plugins/routines/routineTurnContext.js';

/**
 * Phase C.2 — `routineTurnContext` raw-tool-result ALS.
 *
 * The runner installs a `Map<toolName, unknown>` in this storage so the
 * orchestrator's dispatchTool capture callback can stash pre-tokenisation
 * results into it, and later template rendering (C.4/C.5) can read it
 * back. These tests pin the ALS semantics so the runner / future template
 * renderer can rely on them.
 */

describe('routineTurnContext — raw tool-result storage', () => {
  it('currentRawToolResults is undefined outside any scope', () => {
    assert.equal(routineTurnContext.currentRawToolResults(), undefined);
  });

  it('withRawToolResults exposes the supplied map to nested code', async () => {
    const map = new Map<string, unknown>();
    let observed: Map<string, unknown> | undefined;
    await routineTurnContext.withRawToolResults(map, async () => {
      observed = routineTurnContext.currentRawToolResults();
    });
    assert.equal(observed, map);
  });

  it('mutations to the map inside the scope are visible to the caller after the scope exits', async () => {
    const map = new Map<string, unknown>();
    await routineTurnContext.withRawToolResults(map, async () => {
      routineTurnContext
        .currentRawToolResults()!
        .set('query_odoo_hr', { absences: [{ name: 'Anna Müller' }] });
      routineTurnContext
        .currentRawToolResults()!
        .set('query_knowledge_graph', '[{"id":"node-1"}]');
    });
    assert.equal(map.size, 2);
    assert.deepEqual(map.get('query_odoo_hr'), {
      absences: [{ name: 'Anna Müller' }],
    });
    assert.equal(map.get('query_knowledge_graph'), '[{"id":"node-1"}]');
  });

  it('last-write-wins on repeated tool-name writes', async () => {
    const map = new Map<string, unknown>();
    await routineTurnContext.withRawToolResults(map, async () => {
      const live = routineTurnContext.currentRawToolResults()!;
      live.set('query_odoo_hr', 'first');
      live.set('query_odoo_hr', 'second');
    });
    assert.equal(map.get('query_odoo_hr'), 'second');
    assert.equal(map.size, 1);
  });

  it('scope is cleared after the runner returns — next call sees undefined', async () => {
    await routineTurnContext.withRawToolResults(new Map(), async () => {
      assert.ok(routineTurnContext.currentRawToolResults() !== undefined);
    });
    assert.equal(routineTurnContext.currentRawToolResults(), undefined);
  });

  it('parallel routine turns each see their own map (ALS isolation)', async () => {
    const observed: Array<Map<string, unknown> | undefined> = [];
    const mapA = new Map<string, unknown>();
    const mapB = new Map<string, unknown>();
    await Promise.all([
      routineTurnContext.withRawToolResults(mapA, async () => {
        await new Promise((r) => setImmediate(r));
        observed.push(routineTurnContext.currentRawToolResults());
      }),
      routineTurnContext.withRawToolResults(mapB, async () => {
        await new Promise((r) => setImmediate(r));
        observed.push(routineTurnContext.currentRawToolResults());
      }),
    ]);
    assert.equal(observed.length, 2);
    assert.notEqual(observed[0], observed[1]);
    assert.ok(observed.includes(mapA));
    assert.ok(observed.includes(mapB));
  });

  it('preserves the legacy ManageRoutineContext API (independent ALS)', async () => {
    const map = new Map<string, unknown>();
    let manageCtx: unknown;
    let rawMap: Map<string, unknown> | undefined;
    await routineTurnContext.run(
      {
        tenant: 'tenant-A',
        userId: 'user-1',
        channel: 'teams',
        conversationRef: { kind: 'stub' },
      },
      () =>
        routineTurnContext.withRawToolResults(map, async () => {
          manageCtx = routineTurnContext.current();
          rawMap = routineTurnContext.currentRawToolResults();
        }),
    );
    assert.deepEqual(manageCtx, {
      tenant: 'tenant-A',
      userId: 'user-1',
      channel: 'teams',
      conversationRef: { kind: 'stub' },
    });
    assert.equal(rawMap, map);
  });
});
