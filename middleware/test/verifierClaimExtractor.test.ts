import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { ClaimExtractor, claimContext } from '@omadia/verifier';

// --- Stubs ---------------------------------------------------------------

function stubLlm(claims: unknown[]): unknown {
  return {
    complete(): Promise<{ content: unknown[] }> {
      return Promise.resolve({
        content: [
          { type: 'tool_call', name: 'record_claims', id: 'toolu_x', input: { claims } },
        ],
      });
    },
  };
}

const ANSWER =
  'Anna Müller wechselte am 01.03.2023 in die IT-Abteilung [ref:n_emp_anna]. Sie leitet dort das Team. Fragen? Gern!';

// --- Tests ---------------------------------------------------------------

describe('verifier/claimExtractor - claimContext (enclosing sentence)', () => {
  it('returns the sentence around a fragment, cut at sentence boundaries', () => {
    assert.equal(
      claimContext('in die IT-Abteilung', ANSWER),
      'Anna Müller wechselte am 01.03.2023 in die IT-Abteilung [ref:n_emp_anna].',
    );
    assert.equal(claimContext('das Team', ANSWER), 'Sie leitet dort das Team.');
  });

  it('does not treat the dot inside a date or abbreviation as a sentence end', () => {
    assert.equal(
      claimContext('IT-Abteilung', 'Sie kam am 01.03.2023 zur IT-Abteilung. Ende.'),
      'Sie kam am 01.03.2023 zur IT-Abteilung.',
    );
  });

  it('matches case-insensitively and returns undefined when the span is absent or already a full sentence', () => {
    assert.equal(
      claimContext('anna müller wechselte am 01.03.2023 in die it-abteilung [ref:n_emp_anna].', ANSWER),
      undefined,
      'claim is the whole sentence → no extra context',
    );
    assert.equal(claimContext('Buchhaltung', ANSWER), undefined);
    assert.equal(claimContext('', ANSWER), undefined);
  });

  it('caps the context length', () => {
    const long = `${'x'.repeat(600)} Kern ${'y'.repeat(600)}`;
    const ctx = claimContext('Kern', long);
    assert.ok(ctx && ctx.length <= 400, `got ${String(ctx?.length)}`);
    assert.match(ctx!, /Kern/);
  });
});

describe('verifier/claimExtractor - extract', () => {
  it('attaches context to fragment claims and leaves full-sentence claims without', async () => {
    const extractor = new ClaimExtractor({
      llm: stubLlm([
        { text: 'in die IT-Abteilung', type: 'qualitative', expected_source: 'graph' },
        {
          text: 'Anna Müller wechselte am 01.03.2023 in die IT-Abteilung [ref:n_emp_anna].',
          type: 'qualitative',
          expected_source: 'graph',
        },
      ]) as never,
      log: () => undefined,
    });
    const claims = await extractor.extract({ userMessage: 'Wo arbeitet Anna?', answer: ANSWER });
    assert.equal(claims.length, 2);
    assert.equal(
      claims[0]!.context,
      'Anna Müller wechselte am 01.03.2023 in die IT-Abteilung [ref:n_emp_anna].',
    );
    assert.equal(claims[1]!.context, undefined);
  });
});
