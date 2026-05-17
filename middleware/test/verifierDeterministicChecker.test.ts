import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  DeterministicChecker,
  type GraphReader,
  type HardClaim,
} from '@omadia/verifier';

// --- Stubs ---------------------------------------------------------------

function stubGraph(
  hits: Array<{ id: string; props?: Readonly<Record<string, unknown>> }>,
): GraphReader {
  return {
    findEntities(): Promise<Array<{ id: string; props?: Readonly<Record<string, unknown>> }>> {
      return Promise.resolve(hits);
    },
  };
}

function makeAmountClaim(overrides: Partial<HardClaim> = {}): HardClaim {
  return {
    id: 'c_001',
    text: '1.234,56 €',
    type: 'amount',
    expectedSource: 'odoo',
    value: 1234.56,
    unit: '€',
    sourceRecord: { model: 'account.move', id: 42 },
    relatedEntities: [],
    ...overrides,
  } as HardClaim;
}

// --- Tests ---------------------------------------------------------------

// The core DeterministicChecker handles only `expectedSource === 'graph'`.
// All other sources (e.g. 'odoo') return `unverified` with a message
// directing operators to install a SourceChecker plugin for that domain.
// The Odoo-specific amount/aggregate/date/id checks were intentionally
// extracted to a plugin to keep the core verifier source-neutral.

describe('verifier/deterministicChecker - amount', () => {
  it('returns unverified for odoo-source amount (no SourceChecker installed)', async () => {
    const checker = new DeterministicChecker({});
    const verdict = await checker.check(makeAmountClaim());
    assert.equal(verdict.status, 'unverified');
  });

  it('returns unverified regardless of amount value when source is odoo', async () => {
    const checker = new DeterministicChecker({});
    const verdict = await checker.check(makeAmountClaim({ value: 9999.99 }));
    assert.equal(verdict.status, 'unverified');
  });

  it('unverifies when no odoo reader configured', async () => {
    const checker = new DeterministicChecker({});
    const verdict = await checker.check(makeAmountClaim());
    assert.equal(verdict.status, 'unverified');
  });

  it('unverifies when the model has no known amount field', async () => {
    const checker = new DeterministicChecker({});
    const verdict = await checker.check(
      makeAmountClaim({ sourceRecord: { model: 'unknown.model', id: 1 } }),
    );
    assert.equal(verdict.status, 'unverified');
  });

  it('handles German number formatting in value — returns unverified (no Odoo checker)', async () => {
    const checker = new DeterministicChecker({});
    const verdict = await checker.check(
      makeAmountClaim({ value: '1.234,56 €' }),
    );
    assert.equal(verdict.status, 'unverified');
  });
});

describe('verifier/deterministicChecker - aggregate (HR re-compute)', () => {
  it('returns unverified for odoo-source aggregate (no SourceChecker installed)', async () => {
    const checker = new DeterministicChecker({});
    const claim: HardClaim = {
      id: 'c_001',
      text: '12 Urlaubstage',
      type: 'aggregate',
      expectedSource: 'odoo',
      value: 12,
      unit: 'd',
      sourceRecord: { model: 'hr.leave' },
      relatedEntities: ['hr.employee:7'],
      aggregation: 'sum',
    };
    const verdict = await checker.check(claim);
    assert.equal(verdict.status, 'unverified');
  });

  it('returns unverified when claimed total would be wrong (no Odoo checker)', async () => {
    const checker = new DeterministicChecker({});
    const claim: HardClaim = {
      id: 'c_001',
      text: '12 Urlaubstage',
      type: 'aggregate',
      expectedSource: 'odoo',
      value: 12,
      sourceRecord: { model: 'hr.leave' },
      relatedEntities: ['hr.employee:7'],
      aggregation: 'sum',
    };
    const verdict = await checker.check(claim);
    assert.equal(verdict.status, 'unverified');
  });

  it('supports count aggregation — returns unverified (no Odoo checker)', async () => {
    const checker = new DeterministicChecker({});
    const claim: HardClaim = {
      id: 'c_001',
      text: '3 offene Rechnungen',
      type: 'aggregate',
      expectedSource: 'odoo',
      value: 3,
      sourceRecord: { model: 'account.move' },
      relatedEntities: [],
      aggregation: 'count',
    };
    const verdict = await checker.check(claim);
    assert.equal(verdict.status, 'unverified');
  });
});

describe('verifier/deterministicChecker - date', () => {
  it('returns unverified for odoo-source date (no SourceChecker installed)', async () => {
    const checker = new DeterministicChecker({});
    const claim: HardClaim = {
      id: 'c_001',
      text: '2026-04-19',
      type: 'date',
      expectedSource: 'odoo',
      value: '2026-04-19',
      sourceRecord: { model: 'account.move', id: 42 },
      relatedEntities: [],
    };
    const verdict = await checker.check(claim);
    assert.equal(verdict.status, 'unverified');
  });

  it('returns unverified for German-formatted date (no Odoo checker)', async () => {
    const checker = new DeterministicChecker({});
    const claim: HardClaim = {
      id: 'c_001',
      text: 'Fällig am 19.04.2026',
      type: 'date',
      expectedSource: 'odoo',
      value: '19.04.2026',
      sourceRecord: { model: 'account.move', id: 42 },
      relatedEntities: [],
    };
    const verdict = await checker.check(claim);
    assert.equal(verdict.status, 'unverified');
  });

  it('returns unverified regardless of date divergence (no Odoo checker)', async () => {
    const checker = new DeterministicChecker({});
    const claim: HardClaim = {
      id: 'c_001',
      text: '2026-04-19',
      type: 'date',
      expectedSource: 'odoo',
      value: '2026-04-19',
      sourceRecord: { model: 'account.move', id: 42 },
      relatedEntities: [],
    };
    const verdict = await checker.check(claim);
    assert.equal(verdict.status, 'unverified');
  });
});

describe('verifier/deterministicChecker - id', () => {
  it('returns unverified for odoo-source id (no SourceChecker installed)', async () => {
    const checker = new DeterministicChecker({});
    const claim: HardClaim = {
      id: 'c_001',
      text: 'Rechnung',
      type: 'id',
      expectedSource: 'odoo',
      sourceRecord: { model: 'account.move', id: 42 },
      relatedEntities: [],
    };
    const verdict = await checker.check(claim);
    assert.equal(verdict.status, 'unverified');
  });

  it('returns unverified for odoo ref-based id (no SourceChecker)', async () => {
    const checker = new DeterministicChecker({});
    const claim: HardClaim = {
      id: 'c_001',
      text: 'INV/2026/0042',
      type: 'id',
      expectedSource: 'odoo',
      sourceRecord: { model: 'account.move', ref: 'INV/2026/0042' },
      relatedEntities: [],
    };
    const verdict = await checker.check(claim);
    assert.equal(verdict.status, 'unverified');
  });

  it('returns unverified even when ref does not exist (no Odoo checker)', async () => {
    const checker = new DeterministicChecker({});
    const claim: HardClaim = {
      id: 'c_001',
      text: 'INV/2026/9999',
      type: 'id',
      expectedSource: 'odoo',
      sourceRecord: { model: 'account.move', ref: 'INV/2026/9999' },
      relatedEntities: [],
    };
    const verdict = await checker.check(claim);
    assert.equal(verdict.status, 'unverified');
  });
});

describe('verifier/deterministicChecker - graph', () => {
  it('verifies id claim when graph has a matching entity', async () => {
    const graph = stubGraph([{ id: 'res.partner:42', props: { displayName: 'Lilium' } }]);
    const checker = new DeterministicChecker({ graph });
    const claim: HardClaim = {
      id: 'c_001',
      text: 'Lilium',
      type: 'id',
      expectedSource: 'graph',
      value: 'Lilium',
      sourceRecord: { model: 'res.partner', ref: 'Lilium' },
      relatedEntities: [],
    };
    const verdict = await checker.check(claim);
    assert.equal(verdict.status, 'verified');
  });

  it('contradicts when graph has no hits', async () => {
    const graph = stubGraph([]);
    const checker = new DeterministicChecker({ graph });
    const claim: HardClaim = {
      id: 'c_001',
      text: 'Mystery Corp',
      type: 'id',
      expectedSource: 'graph',
      value: 'Mystery Corp',
      sourceRecord: { model: 'res.partner', ref: 'Mystery Corp' },
      relatedEntities: [],
    };
    const verdict = await checker.check(claim);
    assert.equal(verdict.status, 'contradicted');
  });
});

describe('verifier/deterministicChecker - error handling', () => {
  it('returns unverified (not thrown) on non-graph source — no SourceChecker registered', async () => {
    const checker = new DeterministicChecker({
      log: (): void => {
        /* silent */
      },
    });
    const verdict = await checker.check(makeAmountClaim());
    assert.equal(verdict.status, 'unverified');
    if (verdict.status === 'unverified') {
      assert.match(verdict.reason, /no deterministic checker registered for source/);
    }
  });
});
