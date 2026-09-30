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

  it('does not treat the dot inside a date, an ordinal or an abbreviation as a sentence end', () => {
    assert.equal(
      claimContext('IT-Abteilung', 'Sie kam am 01.03.2023 zur IT-Abteilung. Ende.'),
      'Sie kam am 01.03.2023 zur IT-Abteilung.',
    );
    assert.equal(
      claimContext('in die IT-Abteilung', 'Anna wechselte z.B. in die IT-Abteilung. Ende.'),
      'Anna wechselte z.B. in die IT-Abteilung.',
    );
    assert.equal(
      claimContext('in die IT', 'Anna wechselte am 1. März in die IT. Ende.'),
      'Anna wechselte am 1. März in die IT.',
    );
    assert.equal(
      claimContext('Buchhaltung', 'Vorher. Dr. Müller leitet die Buchhaltung. Danach.'),
      'Dr. Müller leitet die Buchhaltung.',
    );
  });

  it('returns undefined when the span occurs in more than one sentence (no guessing the subject)', () => {
    assert.equal(
      claimContext('in der IT', 'Bob ist in der IT. Anna wechselte in der IT-Abteilung.'),
      undefined,
    );
    // Twice inside the SAME sentence is fine.
    assert.equal(
      claimContext('IT', 'Anna ist in der IT, genauer der IT-Leitung. Ende.'),
      'Anna ist in der IT, genauer der IT-Leitung.',
    );
  });

  it('treats markdown bullets / newlines as sentence boundaries', () => {
    assert.equal(
      claimContext('IT-Abteilung', '- Anna: IT-Abteilung\n- Bob: Sales'),
      '- Anna: IT-Abteilung',
    );
  });

  it('suppresses a context that equals the claim modulo trailing punctuation', () => {
    assert.equal(claimContext('Der Vertrag ist beendet', 'Der Vertrag ist beendet.'), undefined);
    assert.equal(
      claimContext('Der Vertrag ist beendet.', 'Der Vertrag ist beendet. Mehr dazu.'),
      undefined,
    );
  });

  it('bails out when lower-casing would shift offsets (U+0130)', () => {
    assert.equal(claimContext('Sales', 'İstanbul-Team: Sales. Ende.'), undefined);
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
