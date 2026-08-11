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
