/**
 * #2294 — bulk promotion runs the live path's discretion check on every
 * stored turn: a turn that read another conversation is not promoted into a
 * tier whose readers may not know it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Pool, PoolClient, QueryResult } from 'pg';

import { createBulkPromotionService } from '@omadia/orchestrator-extras/dist/bulkPromotion.js';
import type { BulkPromotionService, KnowledgeGraph } from '@omadia/plugin-api';

import {
  createBulkPromotionGate,
  withBulkPromotionGate,
} from '../../packages/harness-orchestrator/src/discretion/bulkPromotionGate.js';
import { readersOf, unionLabels, type LabelSet } from '../../packages/harness-orchestrator/src/discretion/labels.js';
import type { DiscretionAuditEntry, DiscretionPort } from '../../packages/harness-orchestrator/src/discretion/port.js';

const OWN = unionLabels([{ kind: 'context', key: 'telegram:dm-ab', readers: readersOf(['a', 'b']) }]);
const FOREIGN = unionLabels([
  { kind: 'context', key: 'telegram:dm-ab', readers: readersOf(['a', 'b']) },
  { kind: 'context', key: 'teams:hr-room', readers: readersOf(['a', 'hr']) },
]);

function port(labels: Record<string, LabelSet>, audits: DiscretionAuditEntry[] = []): DiscretionPort {
  return {
    declarationOf: () => Promise.resolve(undefined),
    labelsOf: (_kind, ids) =>
      Promise.resolve(new Map(ids.flatMap((id) => (labels[id] ? [[id, labels[id]] as const] : [])))),
    persistLabels: () => Promise.resolve(),
    audit: (entry) => {
      audits.push(entry);
    },
  };
}

describe('#2294 — createBulkPromotionGate', () => {
  it('lets a turn that read only its own conversation into its own tier', async () => {
    const gate = createBulkPromotionGate(port({ t1: OWN }));
    assert.equal(await gate({ turnId: 't1', owners: ['a', 'b'] }), true);
    // Agent memory (readers unknown) as live: the own conversation passes.
    assert.equal(await gate({ turnId: 't1' }), true);
  });

  it('refuses a turn that read another conversation whose readers the tier does not cover', async () => {
    const audits: DiscretionAuditEntry[] = [];
    const gate = createBulkPromotionGate(port({ t2: FOREIGN }, audits));
    assert.equal(await gate({ turnId: 't2', owners: ['a', 'b'], agentSlug: 'desk' }), false);
    assert.equal(await gate({ turnId: 't2' }), false);
    assert.equal(audits[0]?.target, 'bulk-promotion');
    assert.equal(audits[0]?.allowed, false);
  });

  it('allows the foreign context when every reader of the tier may know it', async () => {
    const gate = createBulkPromotionGate(port({ t2: FOREIGN }));
    assert.equal(await gate({ turnId: 't2', owners: ['a'] }), true);
  });

  it('lets a turn without stored labels through, like an unlabelled live turn', async () => {
    const gate = createBulkPromotionGate(port({}));
    assert.equal(await gate({ turnId: 'old' }), true);
  });
});

const retired: unknown[][] = [];

function candidatePool(): Pool {
  const query = async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
    if (/promotionRetired/.test(sql) && /UPDATE/.test(sql)) retired.push(params);
    const rows = /t\.significance >= \$2/.test(sql)
      ? [{ external_id: 't2', user_id: 'a', scope: 'desk::telegram::dm-ab', owners: ['a', 'b'], user_message: 'q', assistant_answer: 'a' }]
      : [];
    return { command: '', rowCount: rows.length, oid: 0, rows, fields: [] } as unknown as QueryResult;
  };
  return {
    query,
    connect: () => Promise.resolve({ query, release: () => {} } as unknown as PoolClient),
  } as unknown as Pool;
}

describe('#2294 — the decorated bulk-promotion service', () => {
  it('skips a refused turn before any promotion work', async () => {
    const inner = createBulkPromotionService({
      pool: candidatePool(),
      tenantId: 't',
      kg: {} as KnowledgeGraph,
      scorer: { score: () => Promise.resolve({ score: 0.9 }) },
      log: () => {},
    });
    const gated: BulkPromotionService = withBulkPromotionGate(inner, port({ t2: FOREIGN }));
    const result = await gated.run();
    assert.equal(result.promotePhase.scanned, 1);
    assert.equal(result.promotePhase.skipped, 1);
    assert.equal(result.promotePhase.promoted, 0);
    assert.equal(result.promotePhase.failed, 0);
    assert.ok(retired.some((params) => params[3] === 'discretion'), 'refused turn retired');
  });

  it('refuses when the gate throws (fail closed)', async () => {
    const inner = createBulkPromotionService({
      pool: candidatePool(),
      tenantId: 't',
      kg: {} as KnowledgeGraph,
      scorer: { score: () => Promise.resolve({ score: 0.9 }) },
      log: () => {},
    });
    const result = await inner.run({ mayPromote: () => Promise.reject(new Error('db down')) });
    assert.equal(result.promotePhase.skipped, 1);
    assert.equal(result.promotePhase.promoted, 0);
  });
});
