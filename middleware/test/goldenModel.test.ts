/**
 * #129 — key-free tests for the golden-set MODEL layer (`goldenModel.ts`).
 *
 * The pure harness (voting/parsing) is covered in `goldenRunner.test.ts`. This
 * suite covers the part that actually wires a real `VerifierPipeline`:
 * `buildVerifierRunOnce` → `toVerifierInput` → `pipeline.verify`. Without a test
 * here that wiring is decorative in CI — a bug that drops a trace field (say
 * `knowledgeGraphToolsCalled`) would only surface against a real API key on
 * `main`, i.e. after merge.
 *
 * We exploit that the two synthetic block paths need NO model: a
 * `tool_postcondition` violation and a `citation_missing` condition
 * (knowledge-graph used, answer carries no `[ref:]` marker) both inject a
 * `contradicted` verdict before/independent of claim extraction. A STUB
 * `LlmProvider` that returns empty content (the extractor treats that as "no
 * claims") lets us drive the real pipeline to a `blocked` verdict with zero
 * tokens and no key — and a control entry proves we are not merely
 * always-blocking.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { LlmProvider } from '@omadia/llm-provider-api';

import { buildVerifierRunOnce } from './golden/goldenModel.js';
import type { GoldenEntry } from './golden/goldenRunner.js';

/** A provider whose `complete` returns no content — so `ClaimExtractor` finds no
 *  tool call and yields zero claims. `stream`/`classifyError` are never reached
 *  on the verify path, so they throw if the wiring ever routes through them. */
function stubProvider(onComplete?: () => void): LlmProvider {
  return {
    id: 'stub',
    capabilities: {
      tools: true,
      vision: false,
      streaming: false,
      promptCaching: false,
      forcedToolChoice: true,
      parallelToolCalls: false,
      interleavedToolUse: false,
    },
    complete(_req) {
      onComplete?.();
      return Promise.resolve({
        content: [],
        finishReason: 'stop',
        model: 'stub',
        usage: { inputTokens: 0, outputTokens: 0 },
      });
    },
    stream() {
      throw new Error('stub: stream() must not be called on the verify path');
    },
    classifyError() {
      throw new Error('stub: classifyError() must not be called on the verify path');
    },
  };
}

/**
 * A provider whose `complete` returns a fixed `record_claims` tool call — it
 * lets us drive the REAL ClaimExtractor -> classify -> DeterministicChecker path
 * deterministically (no key, no model jitter). We use it to pin the
 * hard-claim amount branch and the verdict-tag projection that the live corpus
 * (majority-of-3, value-fill dependent) deliberately does not lean on.
 */
function claimStub(claims: unknown[]): LlmProvider {
  return {
    id: 'stub',
    capabilities: {
      tools: true,
      vision: false,
      streaming: false,
      promptCaching: false,
      forcedToolChoice: true,
      parallelToolCalls: false,
      interleavedToolUse: false,
    },
    complete(_req) {
      return Promise.resolve({
        content: [
          { type: 'tool_call', id: 'call_x', name: 'record_claims', input: { claims } },
        ],
        finishReason: 'stop',
        model: 'stub',
        usage: { inputTokens: 5, outputTokens: 5 },
      });
    },
    stream() {
      throw new Error('stub: stream() must not be called on the verify path');
    },
    classifyError() {
      throw new Error('stub: classifyError() must not be called on the verify path');
    },
  };
}

describe('goldenModel/deterministic hard-claim path (#639 v2, key-free)', () => {
  // A currency amount triggers the router; the stub extracts it as an amount
  // claim pinned to account.move:42; the odoo fixture supplies amount_total.
  const answer = 'Der Gesamtbetrag von INV/2026/0042 beträgt 1.234,56 €.';
  const amountClaim = {
    text: '1.234,56 €',
    type: 'amount',
    expected_source: 'odoo',
    value: 1234.56,
    unit: '€',
    odoo_record: { model: 'account.move', id: 42 },
  };
  function entry(amount_total: number): GoldenEntry {
    return {
      id: 'det',
      userMessage: 'Wie hoch ist der Gesamtbetrag von INV/2026/0042?',
      answer,
      trace: { agent: 'accounting', domainToolsCalled: ['query_odoo_accounting'] },
      odoo: { records: [{ model: 'account.move', id: 42, fields: { amount_total } }] },
      expected: { status: 'approved' },
    };
  }

  it('APPROVES via a deterministic-verified amount and tags the verdict (Gap 1)', async () => {
    const r = await buildVerifierRunOnce(claimStub([amountClaim]), 'stub-model')(entry(1234.56));
    assert.equal(r.status, 'approved');
    assert.ok(
      r.verdicts?.some((v) => v.status === 'verified' && v.claimType === 'amount'),
      'expected a verified amount tag so `via: deterministic-verified` can be asserted',
    );
  });

  it('BLOCKS via a deterministic contradiction when the ERP amount differs (Gap 2)', async () => {
    const r = await buildVerifierRunOnce(claimStub([amountClaim]), 'stub-model')(entry(2000));
    assert.equal(r.status, 'blocked');
    assert.ok(
      r.verdicts?.some((v) => v.status === 'contradicted' && v.claimType === 'amount'),
      'expected a contradicted amount tag',
    );
  });

  it('without an odoo fixture the same claim resolves unverified -> disclaimer (v1 behaviour)', async () => {
    const noReader: GoldenEntry = { ...entry(1234.56), odoo: undefined };
    const r = await buildVerifierRunOnce(claimStub([amountClaim]), 'stub-model')(noReader);
    assert.equal(r.status, 'approved_with_disclaimer');
  });
});

describe('goldenModel/deterministic id-ref path (#639 v2, key-free)', () => {
  // Key-free PARITY for the branch the two live corpus entries actually ride:
  // an `id` claim with `odoo_record.ref` (no numeric id) drives the REAL
  // checkOdooId `search [['name','=',ref]]` path — distinct from the amount
  // block above, which no key-free test otherwise exercises. The fixture
  // holding the ref => verified => approved; a fixture with only a DECOY row
  // => search returns [] => contradicted => blocked.
  const answer =
    'Ja, die Rechnung INV/2026/0042 ist im Odoo-Modell account.move als Datensatz vorhanden.';
  const idClaim = {
    text: 'INV/2026/0042',
    type: 'id',
    expected_source: 'odoo',
    odoo_record: { model: 'account.move', ref: 'INV/2026/0042' },
  };
  function entry(records: Array<{ model: string; id: number; fields: Record<string, unknown> }>): GoldenEntry {
    return {
      id: 'det-id',
      userMessage: 'Existiert die Rechnung INV/2026/0042 in unserem ERP?',
      answer,
      trace: { agent: 'accounting', domainToolsCalled: ['query_odoo_accounting'] },
      odoo: { records },
      expected: { status: 'approved' },
    };
  }
  const present = [
    { model: 'account.move', id: 42, fields: { name: 'INV/2026/0042', amount_total: 1234.56 } },
  ];
  const decoyOnly = [
    { model: 'account.move', id: 7, fields: { name: 'INV/2026/0007', amount_total: 99 } },
  ];

  it('APPROVES via a deterministic-verified id/ref existence check (Gap 1 path)', async () => {
    const r = await buildVerifierRunOnce(claimStub([idClaim]), 'stub-model')(entry(present));
    assert.equal(r.status, 'approved');
    assert.ok(
      r.verdicts?.some((v) => v.status === 'verified' && v.claimType === 'id'),
      'expected a verified id tag so `via: deterministic-verified` can be asserted',
    );
  });

  it('BLOCKS via a deterministic contradiction when the ref is absent (Gap 2 path)', async () => {
    const r = await buildVerifierRunOnce(claimStub([idClaim]), 'stub-model')(entry(decoyOnly));
    assert.equal(r.status, 'blocked');
    assert.ok(
      r.verdicts?.some((v) => v.status === 'contradicted' && v.claimType === 'id'),
      'expected a contradicted id tag',
    );
  });
});

describe('goldenModel/buildVerifierRunOnce (synthetic paths, key-free)', () => {
  it('blocks via a recorded tool_postcondition violation (#130)', async () => {
    const entry: GoldenEntry = {
      id: 'tp',
      userMessage: 'Wie hoch ist der offene Betrag?',
      answer: 'Der offene Betrag beträgt 1.234,56 €.',
      trace: {
        agent: 'accounting',
        domainToolsCalled: ['query_odoo_accounting'],
        toolPostconditionViolations: [
          {
            toolName: 'query_odoo_accounting',
            callId: 'call_1',
            agentContext: 'accounting',
            issues: ['result.amount_residual missing'],
          },
        ],
      },
      expected: { status: 'blocked' },
    };
    const r = await buildVerifierRunOnce(stubProvider(), 'stub-model')(entry);
    assert.equal(r.status, 'blocked');
  });

  it('blocks via citation_missing when KG was used but no [ref:] marker (#131)', async () => {
    const entry: GoldenEntry = {
      id: 'cm',
      userMessage: 'Wer ist der Ansprechpartner für ACME?',
      answer: 'Der Ansprechpartner für ACME ist Julia Berg.',
      trace: { knowledgeGraphToolsCalled: true },
      expected: { status: 'blocked' },
    };
    const r = await buildVerifierRunOnce(stubProvider(), 'stub-model')(entry);
    assert.equal(r.status, 'blocked');
  });

  it('does NOT block a KG answer that carries a [ref:] marker (control)', async () => {
    // Same trace flag as above, but the marker is present, so the citation
    // synthetic must NOT fire. If `toVerifierInput` dropped
    // `knowledgeGraphToolsCalled`, the block-above case would silently pass for
    // the wrong reason and this control would still be green — the two together
    // pin the wiring. The answer trips no trigger signal, so extraction is
    // skipped and the stub `complete` is never called.
    const entry: GoldenEntry = {
      id: 'ok',
      userMessage: 'Ist die Aufgabe erledigt?',
      answer: 'Alles erledigt [ref:n1].',
      trace: { knowledgeGraphToolsCalled: true },
      expected: { status: 'approved' },
    };
    let calls = 0;
    const r = await buildVerifierRunOnce(stubProvider(() => {
      calls += 1;
    }), 'stub-model')(entry);
    assert.notEqual(r.status, 'blocked');
    assert.equal(calls, 0);
  });

  it('reports zero tokens when the stub reports zero usage', async () => {
    const entry: GoldenEntry = {
      id: 'tok',
      userMessage: 'q',
      answer: 'Der offene Betrag beträgt 1.234,56 €.',
      trace: {
        toolPostconditionViolations: [
          { toolName: 't', callId: 'c', agentContext: 'a', issues: ['x'] },
        ],
      },
      expected: { status: 'blocked' },
    };
    const r = await buildVerifierRunOnce(stubProvider(), 'stub-model')(entry);
    assert.equal(r.tokens, 0);
  });
});
