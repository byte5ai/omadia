import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { ClaimExtractor, claimContext, type VerifierPrivacy } from '@omadia/verifier';
import { findIdentityLeaks } from '@omadia/plugin-privacy-guard/dist/v4/onTheWire.js';

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

// The turn behind a Privacy Shield put surrogates on the wire; the verifier's
// extraction request must see exactly that view, and the claims it returns
// must be restored to real values server-side before anything checks them.
describe('verifier/claimExtractor - privacy view', () => {
  // Not the ANSWER fixture above: its name also appears in the extractor's
  // static system prompt, and the leak check covers the whole request.
  const REAL_NAME = 'Jana Beispielfrau';
  const REAL_DATE = '01.03.2023';
  const SURROGATE_NAME = 'Erika Musterfrau';
  const SURROGATE_DATE = '05.05.1985';
  const REAL_ANSWER = `${REAL_NAME} wechselte am ${REAL_DATE} in die IT-Abteilung [ref:n_emp_jana]. Sie leitet dort das Team. Fragen? Gern!`;
  const PAIRS: ReadonlyArray<readonly [string, string]> = [
    [REAL_NAME, SURROGATE_NAME],
    [REAL_DATE, SURROGATE_DATE],
  ];
  const REAL_USER = `Seit wann arbeitet ${REAL_NAME} in der IT?`;

  function substitute(text: string, from: 0 | 1): string {
    let out = text;
    for (const pair of PAIRS) out = out.split(pair[from]).join(pair[from === 0 ? 1 : 0]);
    return out;
  }

  /** Stands in for the turn's surrogate map: the wire view carries the
   *  surrogates the turn minted, restore maps them back. */
  function fakePrivacy(opts: { blocked?: boolean; wireUserMessage?: string } = {}): {
    view: VerifierPrivacy;
    admitCalls: () => number;
  } {
    let admitCalls = 0;
    const view: VerifierPrivacy = {
      wireUserMessage: opts.wireUserMessage ?? substitute(REAL_USER, 0),
      wireAnswer: substitute(REAL_ANSWER, 0),
      async admitWireView(): Promise<void> {
        admitCalls += 1;
        if (opts.blocked === true) throw new Error('prompt masking blocked');
      },
      async projectForWire(text: string): Promise<string> {
        return substitute(text, 0);
      },
      async restore(text: string): Promise<string> {
        return substitute(text, 1);
      },
    };
    return { view, admitCalls: () => admitCalls };
  }

  function capturingLlm(claims: unknown[]): { llm: unknown; requests: unknown[] } {
    const requests: unknown[] = [];
    return {
      requests,
      llm: {
        complete(req: unknown): Promise<{ content: unknown[] }> {
          requests.push(req);
          return Promise.resolve({
            content: [
              { type: 'tool_call', name: 'record_claims', id: 'toolu_x', input: { claims } },
            ],
          });
        },
      },
    };
  }

  it('sends only the masked view and restores the returned claims', async () => {
    const { view } = fakePrivacy();
    const { llm, requests } = capturingLlm([
      {
        text: `${SURROGATE_NAME} wechselte am ${SURROGATE_DATE} in die IT-Abteilung`,
        type: 'qualitative',
        expected_source: 'graph',
        related_entities: ['odoo:hr.employee:7'],
      },
      { text: SURROGATE_DATE, type: 'date', expected_source: 'odoo', value: SURROGATE_DATE },
      { text: 'in die IT-Abteilung', type: 'qualitative', expected_source: 'graph' },
    ]);
    const extractor = new ClaimExtractor({ llm: llm as never, log: () => undefined });
    const claims = await extractor.extract({
      userMessage: REAL_USER,
      answer: REAL_ANSWER,
      privacy: view,
    });

    assert.equal(requests.length, 1);
    assert.deepEqual(
      findIdentityLeaks(requests[0], [REAL_NAME, REAL_DATE]),
      [],
      'a real value reached the extraction request',
    );
    assert.match(JSON.stringify(requests[0]), new RegExp(SURROGATE_NAME));

    assert.equal(claims.length, 3);
    assert.equal(claims[0]!.text, `${REAL_NAME} wechselte am ${REAL_DATE} in die IT-Abteilung`);
    assert.deepEqual(claims[0]!.relatedEntities, ['odoo:hr.employee:7']);
    // A string value that is itself a surrogate restores to the real literal,
    // normalised to ISO like every extracted date.
    assert.equal(claims[1]!.text, REAL_DATE);
    assert.equal(claims[1]!.value, '2023-03-01');
    // Context is cut from the REAL answer, so the judge gets real subjects
    // server-side (and projects them itself before anything leaves).
    assert.equal(
      claims[2]!.context,
      `${REAL_NAME} wechselte am ${REAL_DATE} in die IT-Abteilung [ref:n_emp_jana].`,
    );
  });

  it('sends the prompt the turn’s model received, never the caller’s own text', async () => {
    // An MCP input-card reply: the caller's text is the envelope with the
    // values typed for a third-party server; the turn's model saw the label.
    const envelope =
      '__mcp_input_reply__ {"correlationId":"x","inputResponses":{"password":"private-secret-value"}}';
    const { view, admitCalls } = fakePrivacy({ wireUserMessage: '[Eingaben übermittelt: password]' });
    const { llm, requests } = capturingLlm([]);
    const extractor = new ClaimExtractor({ llm: llm as never, log: () => undefined });

    await extractor.extract({ userMessage: envelope, answer: REAL_ANSWER, privacy: view });

    assert.equal(requests.length, 1);
    const sent = JSON.stringify(requests[0]);
    assert.equal(sent.includes('private-secret-value'), false, 'the caller’s text reached the request');
    assert.equal(sent.includes('__mcp_input_reply__'), false);
    assert.ok(sent.includes('[Eingaben übermittelt: password]'));
    assert.equal(admitCalls(), 1, 'the request must be admitted (and counted) exactly once');
  });

  it('drops a claim whose span only partially covers a surrogate', async () => {
    const { view } = fakePrivacy();
    const { llm } = capturingLlm([
      // "Musterfrau wechselte" is in the wire answer, but restore cannot map a
      // fragment of a surrogate — it would reach the checker as a fake value.
      { text: 'Musterfrau wechselte', type: 'name', expected_source: 'graph' },
      { text: 'in die IT-Abteilung', type: 'qualitative', expected_source: 'graph' },
    ]);
    const extractor = new ClaimExtractor({ llm: llm as never, log: () => undefined });
    const claims = await extractor.extract({
      userMessage: REAL_USER,
      answer: REAL_ANSWER,
      privacy: view,
    });
    assert.deepEqual(
      claims.map((c) => c.text),
      ['in die IT-Abteilung'],
    );
  });

  /** A view over literal [real, surrogate] pairs; the wire answer is derived. */
  function swapView(
    pairs: ReadonlyArray<readonly [string, string]>,
    realAnswer: string,
  ): VerifierPrivacy {
    const swap = (text: string, from: 0 | 1): string =>
      pairs.reduce((out, pair) => out.split(pair[from]).join(pair[from === 0 ? 1 : 0]), text);
    return {
      wireUserMessage: 'Wie hoch ist das?',
      wireAnswer: swap(realAnswer, 0),
      admitWireView: async () => undefined,
      projectForWire: async (t) => t,
      restore: async (t) => swap(t, 1),
    };
  }

  async function extractWith(
    view: VerifierPrivacy,
    realAnswer: string,
    claims: unknown[],
  ): Promise<Awaited<ReturnType<ClaimExtractor['extract']>>> {
    const { llm } = capturingLlm(claims);
    const extractor = new ClaimExtractor({ llm: llm as never, log: () => undefined });
    return extractor.extract({ userMessage: 'Wie hoch ist das?', answer: realAnswer, privacy: view });
  }

  it('re-derives an amount parsed from a placeholder from the real literal', async () => {
    const realAnswer = 'Das Jahresgehalt beträgt €72,000.';
    const view = swapView([['€72,000', '€10000']], realAnswer);
    const claims = await extractWith(view, realAnswer, [
      { text: '€10000', type: 'amount', expected_source: 'odoo', value: 10000, unit: '€' },
      {
        text: 'Jahresgehalt beträgt €10000',
        type: 'aggregate',
        expected_source: 'odoo',
        value: 10000,
      },
    ]);
    assert.deepEqual(
      claims.map((c) => [c.text, c.value]),
      [
        // 10000 is the surrogate's number; the checker must compare the real
        // 72,000 (English grouping, which a naive parse would read as 72).
        ['€72,000', 72000],
        ['Jahresgehalt beträgt €72,000', 72000],
      ],
    );
  });

  it('re-derives a date parsed from a placeholder, as ISO', async () => {
    const realAnswer = 'Der Vertrag endet am 31.12.2026 regulär.';
    const view = swapView([['31.12.2026', '05.05.1985']], realAnswer);
    const claims = await extractWith(view, realAnswer, [
      // The model normalised the surrogate date itself.
      { text: 'endet am 05.05.1985', type: 'date', expected_source: 'odoo', value: '1985-05-05' },
    ]);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]!.text, 'endet am 31.12.2026');
    assert.equal(claims[0]!.value, '2026-12-31');
  });

  it('keeps a value the model read from a real literal next to a placeholder', async () => {
    const realAnswer = 'Jana Beispielfrau erhielt €500 Prämie mit Rechnung INV/2026/0042.';
    const view = swapView([['Jana Beispielfrau', 'Erika Musterfrau']], realAnswer);
    const claims = await extractWith(view, realAnswer, [
      { text: 'Erika Musterfrau erhielt €500', type: 'amount', expected_source: 'odoo', value: 500 },
      {
        text: 'Erika Musterfrau erhielt €500 Prämie mit Rechnung INV/2026/0042',
        type: 'id',
        expected_source: 'odoo',
        value: 'INV/2026/0042',
      },
    ]);
    assert.deepEqual(
      claims.map((c) => c.value),
      [500, 'INV/2026/0042'],
    );
  });

  it('drops a value that cannot be tied to one real literal', async () => {
    const realAnswer = 'Statt €72,000 sind es €80,000 für Jana Beispielfrau.';
    const view = swapView(
      [
        ['€72,000', '€10000'],
        ['Jana Beispielfrau', 'Erika Musterfrau'],
      ],
      realAnswer,
    );
    const claims = await extractWith(view, realAnswer, [
      // Two amounts in the span: which one the value came from is a guess.
      { text: 'Statt €10000 sind es €80,000', type: 'amount', expected_source: 'odoo', value: 80000 },
      // A value that is only a fragment of a placeholder.
      { text: 'für Erika Musterfrau', type: 'id', expected_source: 'odoo', value: 'Musterfrau' },
    ]);
    assert.equal(claims.length, 2);
    assert.equal(claims[0]!.value, undefined);
    assert.equal(claims[1]!.text, 'für Jana Beispielfrau');
    assert.equal(claims[1]!.value, undefined);
  });

  it('does not check a claim whose check would read the restored sentence instead', async () => {
    const realAnswer = 'Von 01.03.2023 bis 31.12.2026 bleibt Jana Beispielfrau im Team.';
    const view = swapView(
      [
        ['31.12.2026', '05.05.1985'],
        ['Jana Beispielfrau', 'Erika Musterfrau'],
      ],
      realAnswer,
    );
    const claims = await extractWith(view, realAnswer, [
      // Two dates, one a placeholder: without a value the date check would
      // parse the FIRST date of the sentence.
      { text: 'Von 01.03.2023 bis 05.05.1985', type: 'date', expected_source: 'odoo', value: '1985-05-05' },
      // A graph id check without a value searches for the whole sentence.
      { text: 'bleibt Erika Musterfrau im Team', type: 'id', expected_source: 'graph', value: 'Musterfrau' },
      // With a reference to search for, the claim stays checkable.
      {
        text: 'Erika Musterfrau im Team',
        type: 'id',
        expected_source: 'graph',
        value: 'Musterfrau',
        odoo_record: { model: 'hr.employee', ref: 'Erika Musterfrau' },
      },
    ]);
    assert.deepEqual(
      claims.map((c) => [c.text, c.value, c.odooRecord?.ref]),
      [['Jana Beispielfrau im Team', undefined, 'Jana Beispielfrau']],
    );
  });

  it('blocked masking sends nothing and yields no claims', async () => {
    const { view, admitCalls } = fakePrivacy({ blocked: true });
    const { llm, requests } = capturingLlm([
      { text: 'in die IT-Abteilung', type: 'qualitative', expected_source: 'graph' },
    ]);
    const logs: string[] = [];
    const extractor = new ClaimExtractor({
      llm: llm as never,
      log: (m: string) => {
        logs.push(m);
      },
    });
    const claims = await extractor.extract({
      userMessage: REAL_USER,
      answer: REAL_ANSWER,
      privacy: view,
    });
    assert.deepEqual(claims, []);
    assert.equal(admitCalls(), 1);
    assert.equal(requests.length, 0, 'the extractor called the model after masking was blocked');
    assert.ok(logs.some((l) => l.includes('prompt masking blocked')));
  });

  it('without a privacy view the request carries the answer unchanged (no shield installed)', async () => {
    const { llm, requests } = capturingLlm([]);
    const extractor = new ClaimExtractor({ llm: llm as never, log: () => undefined });
    await extractor.extract({ userMessage: REAL_USER, answer: REAL_ANSWER });
    assert.equal(requests.length, 1);
    assert.notDeepEqual(findIdentityLeaks(requests[0], [REAL_NAME]), []);
  });
});
