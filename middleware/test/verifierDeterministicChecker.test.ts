import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  DeterministicChecker,
  hasOdooRecordAnchor,
  type Claim,
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

// #129 golden flake — the extractor sometimes types an invoice-reference claim
// as `qualitative` instead of `id` while still populating `odooRecord.ref`.
// Record existence is checkable regardless of claim type.
describe('verifier/deterministicChecker - checkRecordExists (any claim type)', () => {
  function anchoredQualitative(overrides: Partial<Claim> = {}): Claim {
    return {
      id: 'c_q',
      text: 'die Rechnung INV/2026/0099 ist verbucht und abgeschlossen',
      type: 'qualitative',
      expectedSource: 'odoo',
      odooRecord: { model: 'account.move', ref: 'INV/2026/0099' },
      relatedEntities: [],
      ...overrides,
    };
  }

  it('contradicts a qualitative claim whose anchored ref does not exist', async () => {
    const calls: OdooCall[] = [];
    const odoo = stubOdoo(() => [], calls);
    const checker = new DeterministicChecker({ odoo });
    const verdict = await checker.checkRecordExists(anchoredQualitative());
    assert.equal(verdict.status, 'contradicted');
    assert.equal(calls[0]!.method, 'search');
    assert.deepEqual(calls[0]!.positionalArgs, [[['name', '=', 'INV/2026/0099']]]);
  });

  it('verifies a qualitative claim whose anchored id exists', async () => {
    const odoo = stubOdoo(() => [{ id: 42 }]);
    const checker = new DeterministicChecker({ odoo });
    const verdict = await checker.checkRecordExists(
      anchoredQualitative({ odooRecord: { model: 'account.move', id: 42 } }),
    );
    assert.equal(verdict.status, 'verified');
  });

  it('returns unverified (never throws) when the reader fails or is missing', async () => {
    const throwing = new DeterministicChecker({
      odoo: stubOdoo(() => {
        throw new Error('boom');
      }),
      log: () => undefined,
    });
    assert.equal(
      (await throwing.checkRecordExists(anchoredQualitative())).status,
      'unverified',
    );
    const none = new DeterministicChecker({});
    assert.equal(
      (await none.checkRecordExists(anchoredQualitative())).status,
      'unverified',
    );
  });

  it('returns unverified for a non-odoo or unanchored claim', async () => {
    const checker = new DeterministicChecker({ odoo: stubOdoo(() => [1]) });
    assert.equal(
      (await checker.checkRecordExists(anchoredQualitative({ expectedSource: 'graph' }))).status,
      'unverified',
    );
    const noAnchor = await checker.checkRecordExists(anchoredQualitative({ odooRecord: undefined }));
    assert.equal(noAnchor.status, 'unverified');
    if (noAnchor.status === 'unverified') assert.match(noAnchor.reason, /no odoo record anchor/);
  });

  it('falls back to the model-specific reference field (vendor bill `ref`) before contradicting', async () => {
    const calls: OdooCall[] = [];
    const odoo = stubOdoo((call) => {
      const [[field]] = call.positionalArgs[0] as [[string, string, string]];
      return field === 'ref' ? [7] : [];
    }, calls);
    const checker = new DeterministicChecker({ odoo });
    const verdict = await checker.checkRecordExists(
      anchoredQualitative({
        text: 'Die Lieferantenrechnung RE-4711 ist verbucht',
        odooRecord: { model: 'account.move', ref: 'RE-4711' },
      }),
    );
    assert.equal(verdict.status, 'verified');
    assert.deepEqual(
      calls.map((c) => (c.positionalArgs[0] as [[string]])[0][0]),
      ['name', 'ref'],
    );
  });

  it('stays unverified (judge decides) for a model without a known reference field', async () => {
    const calls: OdooCall[] = [];
    const checker = new DeterministicChecker({ odoo: stubOdoo(() => [], calls) });
    const verdict = await checker.checkRecordExists(
      anchoredQualitative({ odooRecord: { model: 'hr.leave', ref: 'Urlaub 2026-03' } }),
    );
    assert.equal(verdict.status, 'unverified');
    assert.equal(calls.length, 0);
  });

  it('does not treat `name` claims or bare person/company refs as anchors', () => {
    assert.equal(
      hasOdooRecordAnchor(anchoredQualitative({ type: 'name' })),
      false,
      'name claims stay on the judge path',
    );
    assert.equal(
      hasOdooRecordAnchor(
        anchoredQualitative({ odooRecord: { model: 'res.partner', ref: 'ACME GmbH' } }),
      ),
      false,
      'ref without a digit is not a document reference',
    );
    assert.equal(
      hasOdooRecordAnchor(anchoredQualitative({ odooRecord: { model: 'account.move', ref: '' } })),
      false,
    );
    assert.equal(
      hasOdooRecordAnchor(anchoredQualitative({ odooRecord: { model: '', ref: 'INV/1' } })),
      false,
    );
    assert.equal(
      hasOdooRecordAnchor(anchoredQualitative({ odooRecord: { model: 'account.move', id: 0 } })),
      false,
    );
    assert.equal(
      hasOdooRecordAnchor(anchoredQualitative({ odooRecord: { model: 'hr.leave', id: 12 } })),
      true,
      'numeric id anchors on any model',
    );
    assert.equal(hasOdooRecordAnchor(anchoredQualitative()), true);
  });
});
