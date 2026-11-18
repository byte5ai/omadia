/**
 * `ClaimExtractor.extract` keeps a failed extraction apart from an empty one.
 *
 * A result without claims means "the answer holds no claim"; the pipeline
 * reports it as `skipped`. An extraction that could not run, or did not
 * finish, must reject instead, so the pipeline reports `unavailable`: an
 * outage, a response cut off at the token limit or a malformed one is not a
 * clean zero-claim run. The pipeline side of this contract is pinned in
 * `verifierPipelineStates.test.ts`; what an extraction reports as not covered
 * (its `gaps`) in `verifierExtractionCoverage.test.ts` and, for claims that
 * are not in the answer and lists split over several calls,
 * `verifierExtractionVerbatim.test.ts`.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { ClaimExtractor } from '@omadia/verifier';

function extractorOver(
  complete: () => Promise<unknown>,
  opts: { maxClaims?: number } = {},
): {
  extractor: ClaimExtractor;
  logs: string[];
} {
  const logs: string[] = [];
  const extractor = new ClaimExtractor({
    llm: { complete } as never,
    ...opts,
    log: (msg) => {
      logs.push(msg);
    },
  });
  return { extractor, logs };
}

function recordClaimsCall(input: unknown): unknown {
  return {
    content: [{ type: 'tool_call', name: 'record_claims', id: 'toolu_x', input }],
  };
}

const INPUT = {
  userMessage: 'Wie hoch ist die Rechnung?',
  answer: 'Die Rechnung beträgt 1.234,56 €.',
};

/** A well-formed entry whose text is in INPUT.answer. */
const AMOUNT = { text: '1.234,56 €', type: 'amount', expected_source: 'odoo' };

/** A complete extraction that found no claim. */
const NOTHING = { claims: [], gaps: [] };

describe('verifier/claimExtractor - failed extraction vs. empty result', () => {
  it('rejects when the LLM call fails, and still logs the failure', async () => {
    const { extractor, logs } = extractorOver(() =>
      Promise.reject(new Error('rate limit from llm.example.invalid')),
    );
    await assert.rejects(extractor.extract(INPUT), /rate limit/);
    assert.ok(
      logs.some((l) => l.startsWith('[claim-extractor] API FAIL') && l.includes('rate limit')),
      `expected the API FAIL log line, got ${JSON.stringify(logs)}`,
    );
  });

  it('rejects when the response carries no record_claims call', async () => {
    const responses: Array<[string, unknown]> = [
      ['empty content', { content: [] }],
      ['text only', { content: [{ type: 'text', text: 'Keine Angaben.' }] }],
      [
        'a different tool',
        { content: [{ type: 'tool_call', id: 't', name: 'other_tool', input: { claims: [] } }] },
      ],
    ];
    for (const [name, response] of responses) {
      const { extractor, logs } = extractorOver(() => Promise.resolve(response));
      await assert.rejects(
        extractor.extract(INPUT),
        /claim extraction failed: no tool_use block/,
        name,
      );
      assert.ok(
        logs.includes('[claim-extractor] no tool_use block in response'),
        `${name}: expected the no-tool_use log line, got ${JSON.stringify(logs)}`,
      );
    }
  });

  it('rejects when the record_claims call has no claims array', async () => {
    // A bare claim object instead of `{ claims: [...] }`, as a model that
    // ignores the wrapper produces it. Unreadable, so not "no claims".
    const { extractor, logs } = extractorOver(() =>
      Promise.resolve(
        recordClaimsCall({ text: '1.234,56 €', type: 'amount', expected_source: 'odoo' }),
      ),
    );
    await assert.rejects(extractor.extract(INPUT), /claims array/);
    assert.ok(logs.some((l) => l.includes('without a claims array')), JSON.stringify(logs));
  });

  it('resolves no claims when the model reports none', async () => {
    const { extractor } = extractorOver(() => Promise.resolve(recordClaimsCall({ claims: [] })));
    assert.deepEqual(await extractor.extract(INPUT), NOTHING);
  });

  it('resolves no claims but a gap when every returned claim fails the verbatim guard', async () => {
    // The guard keeps a claim the answer does not hold from the checkers, but
    // the model listed something: the result is not "the answer holds no claim".
    const { extractor, logs } = extractorOver(() =>
      Promise.resolve(
        recordClaimsCall({
          claims: [{ text: '9.999,00 €', type: 'amount', expected_source: 'odoo' }],
        }),
      ),
    );
    assert.deepEqual(await extractor.extract(INPUT), {
      claims: [],
      gaps: ['claims_not_in_answer'],
    });
    assert.ok(logs.some((l) => l.includes('not_in_answer=1')), JSON.stringify(logs));
  });

  it('resolves no claims for an empty answer without calling the model', async () => {
    let calls = 0;
    const { extractor } = extractorOver(() => {
      calls += 1;
      return Promise.reject(new Error('must not be called'));
    });
    assert.deepEqual(await extractor.extract({ userMessage: 'Hallo', answer: '   ' }), NOTHING);
    assert.equal(calls, 0);
  });

  it('rejects a response cut off at the token limit, even with a complete claim in it', async () => {
    for (const claims of [[AMOUNT], []]) {
      const { extractor, logs } = extractorOver(() =>
        Promise.resolve({
          ...(recordClaimsCall({ claims }) as object),
          finishReason: 'max_tokens',
        }),
      );
      await assert.rejects(extractor.extract(INPUT), /truncated/, `${String(claims.length)} claim(s)`);
      assert.ok(logs.some((l) => l.includes('truncated')), JSON.stringify(logs));
    }
  });

  it('rejects when an entry breaks the record_claims schema', async () => {
    const broken: Array<[string, unknown[]]> = [
      ['empty entry', [{}]],
      ['not an object', ['1.234,56 €']],
      ['unknown type', [{ ...AMOUNT, type: 'currency' }]],
      ['missing source', [{ text: '1.234,56 €', type: 'amount' }]],
      ['a valid entry next to a broken one', [AMOUNT, { type: 'amount', expected_source: 'odoo' }]],
    ];
    for (const [name, claims] of broken) {
      const { extractor, logs } = extractorOver(() => Promise.resolve(recordClaimsCall({ claims })));
      await assert.rejects(extractor.extract(INPUT), /schema/, name);
      assert.ok(logs.some((l) => l.includes('schema')), `${name}: ${JSON.stringify(logs)}`);
    }
  });

  it('returns every valid claim beyond maxClaims, and reports the full list as a gap', async () => {
    // Cutting here would make the rest of the answer vanish without a trace;
    // the pipeline keeps claims over its cap in the verdict as not checked.
    // Two claims fill the request limit of maxClaims + 1, so the model may
    // have left more out: the result says so instead of passing as complete.
    const { extractor } = extractorOver(
      () =>
        Promise.resolve(
          recordClaimsCall({
            claims: [AMOUNT, { text: '99,00 €', type: 'amount', expected_source: 'odoo' }],
          }),
        ),
      { maxClaims: 1 },
    );
    const { claims, gaps } = await extractor.extract({
      userMessage: 'Und die Gutschrift?',
      answer: 'Die Rechnung beträgt 1.234,56 €, die Gutschrift 99,00 €.',
    });
    assert.deepEqual(
      claims.map((c) => c.text),
      ['1.234,56 €', '99,00 €'],
    );
    assert.deepEqual(gaps, ['claim_list_full']);
  });

  it('a list cut at the request limit is a gap even when the verbatim guard drops entries', async () => {
    // The model stopped listing at the limit either way; what the guard drops
    // afterwards does not make the list complete — and is a gap of its own.
    const { extractor } = extractorOver(
      () =>
        Promise.resolve(
          recordClaimsCall({
            claims: [AMOUNT, { text: '7,00 €', type: 'amount', expected_source: 'odoo' }],
          }),
        ),
      { maxClaims: 1 },
    );
    const { claims, gaps } = await extractor.extract(INPUT);
    assert.equal(claims.length, 1, 'the claim that is not in the answer never reaches a checker');
    assert.deepEqual(gaps, ['claim_list_full', 'claims_not_in_answer']);
  });
});
