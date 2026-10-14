/**
 * The claim extractor's one repair attempt, and the content-free diagnostic.
 *
 * Production (kernel v0.171.3, 2026-10-08 04:33Z and 04:39Z, Haiku 4.5,
 * Privacy Shield on): two extractions failed with "record_claims call without
 * a claims array" and the answers were withheld as `unavailable /
 * extractor_error`. Token telemetry rules out a cut-off (≈500 of 1024 output
 * tokens, no `max_tokens` stop) and an empty call: the model wrote a list's
 * worth of output, just not as a `claims` array. The adapter passes
 * `tool_use.input` through unchanged. Which shape it was is exactly what the
 * new diagnostic records — without any content.
 *
 * Contract pinned here:
 *  - a valid list — and a valid EMPTY list — is read from one call;
 *  - a list written as a JSON-encoded string is decoded, no second call;
 *  - any other unusable response (no call, no claims array, wrong type, a
 *    broken entry, a cut-off) gets exactly ONE more call — same model, token
 *    budget, tools and wire view, admitted and counted again;
 *  - a refusal and a failed API call are not retried;
 *  - two unusable responses reject (→ `unavailable`), never resolve `[]`;
 *  - a real contradiction found after a repair still blocks, and a technical
 *    extraction failure is never presented as a contradiction.
 *
 * Imported from SOURCE so a mutation in `src/` cannot pass over stale `dist/`.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { LlmRequest } from '@omadia/llm-provider';

import { ClaimExtractor } from '../packages/harness-verifier/src/claimExtractor.js';
import { VerifierPipeline } from '../packages/harness-verifier/src/verifierPipeline.js';
import type {
  ClaimVerdict,
  DeterministicChecker,
  EvidenceJudge,
  HardClaim,
  SoftClaim,
  VerifierPrivacy,
} from '../packages/harness-verifier/src/index.js';
import { summarise } from '../packages/harness-orchestrator/src/verifierVerdicts.js';
import { composeVerifierBlockedText } from '../packages/harness-channel-sdk/src/verifierBlocked.js';

// --- fixtures -----------------------------------------------------------

const USER = 'Wie hoch ist die offene Rechnung von Frau Becker?';
const ANSWER = 'Die Rechnung INV/2026/0042 über 1.234,56 € ist seit dem 14.09.2026 fällig.';
const INPUT = { userMessage: USER, answer: ANSWER };

const AMOUNT = {
  text: '1.234,56 €',
  type: 'amount',
  expected_source: 'odoo',
  value: 1234.56,
  odoo_record: { model: 'account.move', ref: 'INV/2026/0042' },
};
const INVOICE = {
  text: 'INV/2026/0042',
  type: 'id',
  expected_source: 'odoo',
  odoo_record: { model: 'account.move', ref: 'INV/2026/0042' },
};

function call(input: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    content: [{ type: 'tool_call', id: 'toolu_1', name: 'record_claims', input }],
    finishReason: 'tool_calls',
    providerFinishReason: 'tool_use',
    model: 'claude-haiku-4-5-20251001',
    usage: { inputTokens: 2248, outputTokens: 496 },
    ...extra,
  };
}

const VALID = call({ claims: [AMOUNT, INVOICE] });

/** A provider that answers each request with the next scripted response
 *  (the last repeats) and records every request. */
function scripted(responses: readonly unknown[]) {
  const requests: LlmRequest[] = [];
  const llm = {
    id: 'anthropic',
    complete(req: LlmRequest): Promise<unknown> {
      requests.push(req);
      const next = responses[Math.min(requests.length - 1, responses.length - 1)];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
  return { llm, requests };
}

function extractorOver(responses: readonly unknown[]) {
  const { llm, requests } = scripted(responses);
  const logs: string[] = [];
  const extractor = new ClaimExtractor({
    llm: llm as never,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 1024,
    log: (msg) => {
      logs.push(msg);
    },
  });
  return { extractor, requests, logs };
}

/** A privacy view whose wire text equals the real text, counting admissions. */
function privacyView(opts: { blockOn?: number } = {}) {
  let admissions = 0;
  const privacy: VerifierPrivacy = {
    wireUserMessage: USER,
    wireAnswer: ANSWER,
    admitWireView(): Promise<void> {
      admissions += 1;
      return admissions === opts.blockOn
        ? Promise.reject(new Error('prompt masking blocked'))
        : Promise.resolve();
    },
    projectForWire: (text: string) => Promise.resolve(text),
    restore: (text: string) => Promise.resolve(text),
  };
  return { privacy, admissions: () => admissions };
}

const systemOf = (req: LlmRequest | undefined): string =>
  typeof req?.system === 'string' ? req.system : JSON.stringify(req?.system ?? '');

// --- valid responses ----------------------------------------------------

describe('claim extractor — valid responses are read from one call', () => {
  it('processes valid claims regularly', async () => {
    const { extractor, requests } = extractorOver([VALID]);
    const result = await extractor.extract(INPUT);
    assert.deepEqual(
      result.claims.map((c) => [c.type, c.text]),
      [
        ['amount', '1.234,56 €'],
        ['id', 'INV/2026/0042'],
      ],
    );
    assert.equal(requests.length, 1, 'no repair for a valid response');
  });

  it('keeps a valid EMPTY list apart from a broken extraction', async () => {
    const empty = extractorOver([call({ claims: [] })]);
    assert.deepEqual(await empty.extractor.extract(INPUT), { claims: [], gaps: [] });
    assert.equal(empty.requests.length, 1, 'an empty list is a complete run — no repair');

    // The same answer with a call that lists nothing readable is not "no claims".
    const broken = extractorOver([call({}), call({})]);
    await assert.rejects(broken.extractor.extract(INPUT), /claims array/);
  });

  it('decodes a list written as a JSON-encoded string without a second call', async () => {
    const { extractor, requests, logs } = extractorOver([
      call({ claims: JSON.stringify([AMOUNT, INVOICE]) }),
    ]);
    const result = await extractor.extract(INPUT);
    assert.equal(result.claims.length, 2);
    assert.equal(requests.length, 1);
    assert.ok(logs.some((l) => l.includes('decoded')), JSON.stringify(logs));
    // A decoded entry still goes through the full schema check.
    const brokenEntry = extractorOver([
      call({ claims: JSON.stringify([{ text: '1.234,56 €' }]) }),
      VALID,
    ]);
    assert.equal((await brokenEntry.extractor.extract(INPUT)).claims.length, 2);
    assert.equal(brokenEntry.requests.length, 2, 'a decoded but broken list is repaired');
  });

  it('never decodes "[]" into a clean empty run — the call goes to the repair', async () => {
    for (const input of [{ claims: '[]' }, { claims: '[]', items: [AMOUNT, INVOICE] }]) {
      const { extractor, requests } = extractorOver([call(input), VALID]);
      assert.equal((await extractor.extract(INPUT)).claims.length, 2, JSON.stringify(input));
      assert.equal(requests.length, 2, `${JSON.stringify(input)}: "[]" is no list`);
    }
    // And with no usable repair either, it stays a failure — never [].
    const twice = extractorOver([call({ claims: '[]' }), call({ claims: '[]' })]);
    await assert.rejects(twice.extractor.extract(INPUT), /claims array/);
  });
});

// --- one repair ---------------------------------------------------------

describe('claim extractor — one targeted repair for an unusable response', () => {
  const unusable: Array<[string, unknown, RegExp]> = [
    ['missing claims (empty input)', call({}), /claims_not_array/],
    ['claims of the wrong type (number)', call({ claims: 42 }), /claims_not_array/],
    ['a single claim instead of a list', call({ claims: AMOUNT }), /claims_not_array/],
    ['a string that is no JSON list', call({ claims: 'siehe oben' }), /claims_not_array/],
    ['no record_claims call', { ...(call({}) as object), content: [{ type: 'text', text: 'x' }] }, /no_tool_call/],
    ['a broken entry', call({ claims: [{ text: '1.234,56 €', type: 'currency', expected_source: 'odoo' }] }), /malformed_entries/],
    ['cut off at the token limit', call({ claims: [AMOUNT] }, { finishReason: 'max_tokens', providerFinishReason: 'max_tokens', usage: { inputTokens: 2201, outputTokens: 1024 } }), /truncated/],
  ];

  for (const [label, first, code] of unusable) {
    it(`repairs ${label} with exactly one more call`, async () => {
      const { extractor, requests, logs } = extractorOver([first, VALID]);
      const result = await extractor.extract(INPUT);
      assert.equal(result.claims.length, 2, label);
      assert.equal(requests.length, 2, `${label}: one repair, no more`);
      const [one, two] = requests;
      // Same model, budget, tool and wire text; only the fixed note is added.
      assert.equal(two?.model, one?.model);
      assert.equal(two?.maxTokens, one?.maxTokens);
      assert.deepEqual(two?.tools, one?.tools);
      assert.deepEqual(two?.toolChoice, { type: 'tool', name: 'record_claims' });
      assert.deepEqual(two?.messages, one?.messages, 'the repair re-sends the same wire text');
      assert.doesNotMatch(systemOf(one), /REPAIR/);
      assert.match(systemOf(two), /REPAIR/);
      assert.ok(logs.some((l) => code.test(l) && l.includes('diag attempt=1')), `${label}: ${JSON.stringify(logs)}`);
      assert.ok(logs.some((l) => l.includes('repair attempt succeeded')), label);
      assert.ok(logs.some((l) => l.includes('attempts=2')), label);
    });
  }

  it('asks a cut-off list to be compact — without dropping what the checks read', async () => {
    const truncated = call({ claims: [AMOUNT] }, { finishReason: 'max_tokens' });
    const { extractor, requests } = extractorOver([truncated, VALID]);
    await extractor.extract(INPUT);
    const note = systemOf(requests[1]);
    assert.match(note, /cut off at the output token limit/);
    assert.match(note, /leave out unit/);
    // related_entities scopes an aggregate's Odoo query and aggregation picks
    // its operator: asking the model to drop them would turn a correct total
    // into a false contradiction.
    assert.match(note, /Keep value, odoo_record, related_entities and aggregation/);
    assert.doesNotMatch(note, /leave out[^.]*related_entities/);
    assert.doesNotMatch(note, /leave out[^.]*aggregation/);
  });

  it('rejects a repair that lists nothing after an unusable first response', async () => {
    // The first response failed — it was not "no claims". An empty repair
    // would release the answer as a clean zero-claim run.
    const { extractor, requests, logs } = extractorOver([call({}), call({ claims: [] })]);
    await assert.rejects(extractor.extract(INPUT), /repair rejected: the repair listed no claims/);
    assert.equal(requests.length, 2);
    assert.ok(logs.some((l) => l.includes('repair rejected')), JSON.stringify(logs));
  });

  it('rejects a repair that lists fewer entries than the first response showed', async () => {
    const brokenOfTwo = call({
      claims: [AMOUNT, { text: 'INV/2026/0042', type: 'reference', expected_source: 'odoo' }],
    });
    const { extractor } = extractorOver([brokenOfTwo, call({ claims: [AMOUNT] })]);
    await assert.rejects(
      extractor.extract(INPUT),
      /repair rejected: the repair listed 1 entries, the first response 2/,
    );
    // The same for a list cut off at the token limit that still showed two.
    const cutOfTwo = call({ claims: [AMOUNT, INVOICE] }, { finishReason: 'max_tokens' });
    const cut = extractorOver([cutOfTwo, call({ claims: [AMOUNT] })]);
    await assert.rejects(cut.extractor.extract(INPUT), /repair rejected/);
  });

  it('keeps a failed repair call’s context: both problems, the cause attached', async () => {
    const { extractor, requests } = extractorOver([call({}), new Error('overloaded')]);
    const err = await extractor.extract(INPUT).then(
      () => assert.fail('must reject'),
      (e: unknown) => e as Error & { cause?: unknown },
    );
    assert.match(err.message, /record_claims call without a claims array; repair call failed: overloaded/);
    assert.ok(err.cause instanceof Error);
    assert.equal(requests.length, 2);
  });

  it('two unusable responses stay a failure — never []', async () => {
    const { extractor, requests, logs } = extractorOver([call({}), call({ claims: 'kaputt' }), VALID]);
    await assert.rejects(
      extractor.extract(INPUT),
      /claim extraction failed: record_claims call without a claims array; repair attempt failed: record_claims call without a claims array/,
    );
    assert.equal(requests.length, 2, 'bounded: the third scripted response is never asked for');
    assert.ok(logs.some((l) => l.includes('diag attempt=2')), JSON.stringify(logs));
  });

  it('two cut-off responses stay a failure', async () => {
    const truncated = call({ claims: [AMOUNT] }, { finishReason: 'max_tokens' });
    const { extractor, requests } = extractorOver([truncated, truncated]);
    await assert.rejects(extractor.extract(INPUT), /truncated.*repair attempt failed: response truncated/);
    assert.equal(requests.length, 2);
  });

  it('does not retry a refusal', async () => {
    const refused = call({}, { refusal: { category: 'cyber' }, providerFinishReason: 'refusal', finishReason: 'stop' });
    const { extractor, requests } = extractorOver([refused, VALID]);
    await assert.rejects(extractor.extract(INPUT), /refused/);
    assert.equal(requests.length, 1);
  });

  it('does not retry a failed API call', async () => {
    const { extractor, requests } = extractorOver([new Error('overloaded'), VALID]);
    await assert.rejects(extractor.extract(INPUT), /overloaded/);
    assert.equal(requests.length, 1);
  });
});

// --- privacy admission + receipt -----------------------------------------

describe('claim extractor — every call is admitted and counted', () => {
  it('admits the repair as a request of its own', async () => {
    const view = privacyView();
    const { extractor, requests } = extractorOver([call({}), VALID]);
    const result = await extractor.extract({ ...INPUT, privacy: view.privacy });
    assert.equal(result.claims.length, 2);
    assert.equal(requests.length, 2);
    assert.equal(view.admissions(), 2, 'one admission — one receipt count — per provider call');
  });

  it('admits a valid extraction once', async () => {
    const view = privacyView();
    const { extractor } = extractorOver([VALID]);
    await extractor.extract({ ...INPUT, privacy: view.privacy });
    assert.equal(view.admissions(), 1);
  });

  it('sends no repair the privacy view does not admit', async () => {
    const view = privacyView({ blockOn: 2 });
    const { extractor, requests } = extractorOver([call({}), VALID]);
    await assert.rejects(
      extractor.extract({ ...INPUT, privacy: view.privacy }),
      /the repair request was not admitted/,
    );
    assert.equal(requests.length, 1, 'the repair was never sent');
  });
});

// --- content-free diagnostic --------------------------------------------

describe('claim extractor — the diagnostic carries no content', () => {
  it('names provider, model, finish, calls, types, keys and tokens — nothing of the turn', async () => {
    const leaky = call({
      claims: { text: '1.234,56 €', note: 'Frau Becker' },
      'Frau Becker schuldet 1.234,56 €': true,
    });
    // Identifier-shaped keys can be content too: only known names are printed.
    const keyed = call({ Becker: 1, INV_2026_0042: true, Anna_Mueller_IBAN_DE89370400440532013000: [] });
    const keyedRun = extractorOver([keyed, keyed]);
    await assert.rejects(keyedRun.extractor.extract(INPUT));
    const keyedDiag = keyedRun.logs.find((l) => l.includes('diag attempt=1')) ?? '';
    assert.match(keyedDiag, /keys=<other:3>/);
    for (const line of keyedRun.logs) {
      assert.doesNotMatch(line, /Becker|INV_2026|Anna|IBAN|DE8937/, line);
    }
    const { extractor, logs } = extractorOver([leaky, leaky]);
    await assert.rejects(extractor.extract(INPUT));
    const diag = logs.filter((l) => l.includes('diag attempt='));
    assert.equal(diag.length, 2, JSON.stringify(logs));
    const first = diag[0]!;
    for (const part of [
      'provider=anthropic',
      'model=claude-haiku-4-5-20251001',
      'finish=tool_calls/tool_use',
      'refusal=no',
      'toolCalls=1',
      'record_claims(input=object keys=claims|<other:1> claims=object(keys=2))',
      'in=2248',
      'out=496',
    ]) {
      assert.ok(first.includes(part), `missing "${part}" in: ${first}`);
    }
    for (const line of logs) {
      assert.doesNotMatch(line, /Becker|1\.234,56|INV\/2026|14\.09\.2026|offene Rechnung/, line);
    }
  });

  it('describes a JSON-string list by its kind and length only', async () => {
    const { extractor, logs } = extractorOver([
      call({ claims: '{"text":"1.234,56 €"}' }),
      call({ claims: '{"text":"1.234,56 €"}' }),
    ]);
    await assert.rejects(extractor.extract(INPUT));
    const diag = logs.find((l) => l.includes('diag attempt=1')) ?? '';
    assert.match(diag, /claims=string\(len=\d+,json=object\)/);
    assert.doesNotMatch(diag, /1\.234,56/);
  });
});

// --- through the pipeline ------------------------------------------------

function pipelineOver(
  responses: readonly unknown[],
  deterministicVerdict: (c: HardClaim) => ClaimVerdict,
) {
  const extract = extractorOver(responses);
  let deterministicCalls = 0;
  let judgeCalls = 0;
  const pipeline = new VerifierPipeline({
    extractor: extract.extractor,
    deterministic: {
      checkAll: (claims: HardClaim[]) => {
        deterministicCalls += 1;
        return Promise.resolve(claims.map(deterministicVerdict));
      },
    } as unknown as DeterministicChecker,
    judge: {
      checkAll: (claims: SoftClaim[]) => {
        judgeCalls += 1;
        return Promise.resolve(
          claims.map((c): ClaimVerdict => ({ status: 'verified', claim: c, source: 'graph' })),
        );
      },
    } as unknown as EvidenceJudge,
    log: () => undefined,
  });
  return {
    pipeline,
    requests: extract.requests,
    deterministicCalls: () => deterministicCalls,
    judgeCalls: () => judgeCalls,
  };
}

describe('pipeline — a repaired extraction is checked like any other', () => {
  it('a real contradiction found after a repair still blocks', async () => {
    const run = pipelineOver([call({}), VALID], (c) =>
      c.type === 'amount'
        ? { status: 'contradicted', claim: c, truth: 999.99, source: 'odoo' }
        : { status: 'verified', claim: c, source: 'odoo' },
    );
    const verdict = await run.pipeline.verify({ runId: 'r1', userMessage: USER, answer: ANSWER });
    assert.equal(verdict.status, 'blocked');
    assert.equal(run.requests.length, 2);
    assert.equal(run.deterministicCalls(), 1, 'the checks run once — no repeated tool work');
    const summary = summarise(verdict, 0, 'enforce');
    assert.equal(summary.withheldCause, 'contradicted');
    assert.equal(summary.contradictionCount, 1);
  });

  it('each attempt is a fresh, forced record_claims call — no tool results, no turn history', async () => {
    // The agent's turn and its tools are re-run by neither attempt (the
    // end-to-end proof against the real orchestrator is in
    // `verifierExtractorRepairEgress.test.ts`); here: the repair carries no
    // tool result and no prior turn, only the extraction prompt.
    const run = pipelineOver([call({ claims: 7 }), VALID], (c) => ({
      status: 'verified',
      claim: c,
      source: 'odoo',
    }));
    await run.pipeline.verify({ runId: 'r2', userMessage: USER, answer: ANSWER });
    assert.equal(run.requests.length, 2);
    for (const req of run.requests) {
      assert.deepEqual(req.toolChoice, { type: 'tool', name: 'record_claims' });
      assert.equal(req.messages.length, 1, 'one user message, no history');
      assert.equal(req.messages[0]?.role, 'user');
      assert.doesNotMatch(JSON.stringify(req.messages), /tool_result/);
    }
    assert.equal(run.deterministicCalls(), 1, 'the checks ran once, after the repair');
  });

  it('two unusable responses: unavailable, a technical fault — never a contradiction', async () => {
    const run = pipelineOver([call({}), call({ claims: '???' })], (c) => ({
      status: 'verified',
      claim: c,
      source: 'odoo',
    }));
    const verdict = await run.pipeline.verify({ runId: 'r3', userMessage: USER, answer: ANSWER });
    assert.deepEqual(
      { status: verdict.status, reason: verdict.status === 'unavailable' ? verdict.reason : undefined },
      { status: 'unavailable', reason: 'extractor_error' },
    );
    assert.equal(run.requests.length, 2);
    assert.equal(run.deterministicCalls(), 0);
    assert.equal(run.judgeCalls(), 0);
    const summary = summarise(verdict, 0, 'enforce');
    assert.equal(summary.withheldCause, 'check_failed');
    assert.equal(summary.contradictionCount, 0);
    assert.equal(summary.badge, 'unavailable');
    const notice = composeVerifierBlockedText('de', summary);
    assert.match(notice, /technischen Störung/);
    assert.doesNotMatch(notice, /Widerspruch/);
  });
});
