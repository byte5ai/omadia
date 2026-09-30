import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { ClaimExtractor, claimContext } from '@omadia/verifier';

// --- Stubs ---------------------------------------------------------------

function stubLlm(claims: unknown[]): unknown {
  return {
    complete(): Promise<unknown> {
      return Promise.resolve(stubLlmResponse(claims));
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

// An empty result means "the answer holds no claim"; the pipeline reports it as
// `skipped`. An extraction that could not run must reject instead, so the
// pipeline reports `unavailable` — an outage is not a clean zero-claim run.
describe('verifier/claimExtractor - extract failure vs. empty result', () => {
  function extractorOver(complete: () => Promise<unknown>): {
    extractor: ClaimExtractor;
    logs: string[];
  } {
    const logs: string[] = [];
    const extractor = new ClaimExtractor({
      llm: { complete } as never,
      log: (msg) => {
        logs.push(msg);
      },
    });
    return { extractor, logs };
  }

  const INPUT = { userMessage: 'Wie hoch ist die Rechnung?', answer: 'Die Rechnung beträgt 1.234,56 €.' };

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
    // A bare claim object instead of `{ claims: [...] }` — what a model that
    // ignores the wrapper produces. Unreadable, so not "no claims".
    const { extractor, logs } = extractorOver(() =>
      Promise.resolve({
        content: [
          {
            type: 'tool_call',
            id: 't',
            name: 'record_claims',
            input: { text: '1.234,56 €', type: 'amount', expected_source: 'odoo' },
          },
        ],
      }),
    );
    await assert.rejects(extractor.extract(INPUT), /claims array/);
    assert.ok(logs.some((l) => l.includes('without a claims array')), JSON.stringify(logs));
  });

  it('resolves [] when the model reports no claims', async () => {
    const { extractor } = extractorOver(() => Promise.resolve(stubLlmResponse([])));
    assert.deepEqual(await extractor.extract(INPUT), []);
  });

  it('resolves [] when every returned claim fails the verbatim guard', async () => {
    const { extractor } = extractorOver(() =>
      Promise.resolve(
        stubLlmResponse([{ text: '9.999,00 €', type: 'amount', expected_source: 'odoo' }]),
      ),
    );
    assert.deepEqual(await extractor.extract(INPUT), []);
  });

  it('resolves [] for an empty answer without calling the model', async () => {
    let calls = 0;
    const { extractor } = extractorOver(() => {
      calls += 1;
      return Promise.reject(new Error('must not be called'));
    });
    assert.deepEqual(await extractor.extract({ userMessage: 'Hallo', answer: '   ' }), []);
    assert.equal(calls, 0);
  });
});

function stubLlmResponse(claims: unknown[]): unknown {
  return {
    content: [{ type: 'tool_call', name: 'record_claims', id: 'toolu_x', input: { claims } }],
  };
}
