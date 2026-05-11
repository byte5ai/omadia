import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  DeterministicChecker,
  type GraphReader,
  type HardClaim,
  type OdooReader,
} from '@omadia/verifier';

// --- Stubs ---------------------------------------------------------------

interface OdooCall {
  model: string;
  method: string;
  positionalArgs: unknown[];
  kwargs: Record<string, unknown>;
}

function stubOdoo(
  handler: (call: OdooCall) => unknown,
  calls?: OdooCall[],
): OdooReader {
  return {
    execute(req) {
      calls?.push(req);
      return Promise.resolve(handler(req));
    },
  };
}

function stubGraph(
  hits: Array<{ id: string; displayName?: string | null }>,
): GraphReader {
  return {
    findEntities(): Promise<Array<{ id: string; displayName?: string | null }>> {
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
    odooRecord: { model: 'account.move', id: 42 },
    relatedEntities: [],
    ...overrides,
  } as HardClaim;
}

// --- Tests ---------------------------------------------------------------

describe('verifier/deterministicChecker - amount', () => {
  it('verifies a matching Odoo amount (within tolerance)', async () => {
    const odoo = stubOdoo(() => [{ amount_total: 1234.56 }]);
    const checker = new DeterministicChecker({ odoo });
    const verdict = await checker.check(makeAmountClaim());
    assert.equal(verdict.status, 'verified');
  });

  it('contradicts when the amount diverges beyond tolerance', async () => {
    const odoo = stubOdoo(() => [{ amount_total: 1200 }]);
    const checker = new DeterministicChecker({ odoo });
    const verdict = await checker.check(makeAmountClaim());
    assert.equal(verdict.status, 'contradicted');
    if (verdict.status === 'contradicted') {
      assert.equal(verdict.truth, 1200);
    }
  });

  it('contradicts when record is missing', async () => {
    const odoo = stubOdoo(() => []);
    const checker = new DeterministicChecker({ odoo });
    const verdict = await checker.check(makeAmountClaim());
    assert.equal(verdict.status, 'contradicted');
  });

  it('unverifies when no odoo reader configured', async () => {
    const checker = new DeterministicChecker({});
    const verdict = await checker.check(makeAmountClaim());
    assert.equal(verdict.status, 'unverified');
  });

  it('unverifies when the model has no known amount field', async () => {
    const odoo = stubOdoo(() => [{ foo: 1 }]);
    const checker = new DeterministicChecker({ odoo });
    const verdict = await checker.check(
      makeAmountClaim({ odooRecord: { model: 'unknown.model', id: 1 } }),
    );
    assert.equal(verdict.status, 'unverified');
  });

  it('handles German number formatting in value', async () => {
    const odoo = stubOdoo(() => [{ amount_total: 1234.56 }]);
    const checker = new DeterministicChecker({ odoo });
    const verdict = await checker.check(
      makeAmountClaim({ value: '1.234,56 €' }),
    );
    assert.equal(verdict.status, 'verified');
  });
});

describe('verifier/deterministicChecker - aggregate (HR re-compute)', () => {
  it('re-computes sum in JS and verifies when it matches', async () => {
    const calls: OdooCall[] = [];
    const odoo = stubOdoo(
      () => [
        { number_of_days: 5 },
        { number_of_days: 3 },
        { number_of_days: 4 },
      ],
      calls,
    );
    const checker = new DeterministicChecker({ odoo });
    const claim: HardClaim = {
      id: 'c_001',
      text: '12 Urlaubstage',
      type: 'aggregate',
      expectedSource: 'odoo',
      value: 12,
      unit: 'd',
      odooRecord: { model: 'hr.leave' },
      relatedEntities: ['hr.employee:7'],
      aggregation: 'sum',
    };
    const verdict = await checker.check(claim);
    assert.equal(verdict.status, 'verified');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, 'search_read');
    assert.deepEqual(calls[0]!.positionalArgs[0], [['employee_id', '=', 7]]);
  });

  it('contradicts when the claimed total is wrong', async () => {
    const odoo = stubOdoo(() => [
      { number_of_days: 5 },
      { number_of_days: 3 },
    ]);
    const checker = new DeterministicChecker({ odoo });
    const claim: HardClaim = {
      id: 'c_001',
      text: '12 Urlaubstage',
      type: 'aggregate',
      expectedSource: 'odoo',
      value: 12,
      odooRecord: { model: 'hr.leave' },
      relatedEntities: ['hr.employee:7'],
      aggregation: 'sum',
    };
    const verdict = await checker.check(claim);
    assert.equal(verdict.status, 'contradicted');
    if (verdict.status === 'contradicted') {
      assert.equal(verdict.truth, 8);
    }
  });

  it('supports count aggregation', async () => {
    const odoo = stubOdoo(() => [{}, {}, {}]);
    const checker = new DeterministicChecker({ odoo });
    const claim: HardClaim = {
      id: 'c_001',
      text: '3 offene Rechnungen',
      type: 'aggregate',
      expectedSource: 'odoo',
      value: 3,
      odooRecord: { model: 'account.move' },
      relatedEntities: [],
      aggregation: 'count',
    };
    const verdict = await checker.check(claim);
    assert.equal(verdict.status, 'verified');
  });
});

describe('verifier/deterministicChecker - date', () => {
  it('verifies matching ISO date', async () => {
    const odoo = stubOdoo(() => [{ invoice_date: '2026-04-19' }]);
    const checker = new DeterministicChecker({ odoo });
    const claim: HardClaim = {
      id: 'c_001',
      text: '2026-04-19',
      type: 'date',
      expectedSource: 'odoo',
      value: '2026-04-19',
      odooRecord: { model: 'account.move', id: 42 },
      relatedEntities: [],
    };
    const verdict = await checker.check(claim);
    assert.equal(verdict.status, 'verified');
  });

  it('normalises German date and verifies', async () => {
    const odoo = stubOdoo(() => [{ invoice_date: '2026-04-19' }]);
    const checker = new DeterministicChecker({ odoo });
    const claim: HardClaim = {
      id: 'c_001',
      text: 'Fällig am 19.04.2026',
      type: 'date',
      expectedSource: 'odoo',
      value: '19.04.2026',
      odooRecord: { model: 'account.move', id: 42 },
      relatedEntities: [],
    };
    const verdict = await checker.check(claim);
    assert.equal(verdict.status, 'verified');
  });

  it('contradicts when the date differs', async () => {
    const odoo = stubOdoo(() => [{ invoice_date: '2026-04-20' }]);
    const checker = new DeterministicChecker({ odoo });
    const claim: HardClaim = {
      id: 'c_001',
      text: '2026-04-19',
      type: 'date',
      expectedSource: 'odoo',
      value: '2026-04-19',
      odooRecord: { model: 'account.move', id: 42 },
      relatedEntities: [],
    };
    const verdict = await checker.check(claim);
    assert.equal(verdict.status, 'contradicted');
  });
});

describe('verifier/deterministicChecker - id', () => {
  it('verifies id via read', async () => {
    const odoo = stubOdoo(() => [{ id: 42 }]);
    const checker = new DeterministicChecker({ odoo });
    const claim: HardClaim = {
      id: 'c_001',
      text: 'Rechnung',
      type: 'id',
      expectedSource: 'odoo',
      odooRecord: { model: 'account.move', id: 42 },
      relatedEntities: [],
    };
    const verdict = await checker.check(claim);
    assert.equal(verdict.status, 'verified');
  });

  it('verifies id via ref using search', async () => {
    const calls: OdooCall[] = [];
    const odoo = stubOdoo(() => [42], calls);
    const checker = new DeterministicChecker({ odoo });
    const claim: HardClaim = {
      id: 'c_001',
      text: 'INV/2026/0042',
      type: 'id',
      expectedSource: 'odoo',
      odooRecord: { model: 'account.move', ref: 'INV/2026/0042' },
      relatedEntities: [],
    };
    const verdict = await checker.check(claim);
    assert.equal(verdict.status, 'verified');
    assert.equal(calls[0]!.method, 'search');
  });

  it('contradicts when ref does not exist', async () => {
    const odoo = stubOdoo(() => []);
    const checker = new DeterministicChecker({ odoo });
    const claim: HardClaim = {
      id: 'c_001',
      text: 'INV/2026/9999',
      type: 'id',
      expectedSource: 'odoo',
      odooRecord: { model: 'account.move', ref: 'INV/2026/9999' },
      relatedEntities: [],
    };
    const verdict = await checker.check(claim);
    assert.equal(verdict.status, 'contradicted');
  });
});

describe('verifier/deterministicChecker - graph', () => {
  it('verifies id claim when graph has a matching entity', async () => {
    const graph = stubGraph([{ id: 'res.partner:42', displayName: 'Lilium' }]);
    const checker = new DeterministicChecker({ graph });
    const claim: HardClaim = {
      id: 'c_001',
      text: 'Lilium',
      type: 'id',
      expectedSource: 'graph',
      odooRecord: { model: 'res.partner', ref: 'Lilium' },
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
      odooRecord: { model: 'res.partner', ref: 'Mystery Corp' },
      relatedEntities: [],
    };
    const verdict = await checker.check(claim);
    assert.equal(verdict.status, 'contradicted');
  });
});

describe('verifier/deterministicChecker - error handling', () => {
  it('returns unverified (not thrown) on reader exception', async () => {
    const odoo: OdooReader = {
      execute(): Promise<unknown> {
        return Promise.reject(new Error('timeout'));
      },
    };
    const checker = new DeterministicChecker({
      odoo,
      log: (): void => {
        /* silent */
      },
    });
    const verdict = await checker.check(makeAmountClaim());
    assert.equal(verdict.status, 'unverified');
    if (verdict.status === 'unverified') {
      assert.match(verdict.reason, /timeout/);
    }
  });
});
