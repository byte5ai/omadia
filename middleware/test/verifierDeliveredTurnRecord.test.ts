/**
 * The answer a verifier delivers is the answer the request records.
 *
 * A request the verifier may re-enter (`enforce`, with a correction retry or
 * a borderline resample) writes ONE session-log row. Before commit-on-delivery
 * the first run wrote it as soon as it ended and a re-entry wrote nothing, so a
 * delivered correction retry left the contradicted first answer in the session
 * log, in the Knowledge-Graph turn, in the next turn's verbatim context, in
 * fact extraction and in `onAfterTurn`, and the stream's `done.turnId` pointed
 * at that row. Now every pass hands its row to the request's ledger and the
 * verifier writes the row of the pass it delivers — or, when it withholds the
 * answer, of the pass its final verdict was about — once.
 *
 * Drives the REAL `Orchestrator` under the REAL `VerifierService`; only the
 * model, the pipeline, the verdict store, the session logger, the fact
 * extractor and the turn-hook runner are recording stubs. All values are
 * synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmRequest } from '@omadia/llm-provider';
import type { FactExtractor } from '@omadia/orchestrator-extras';

import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type {
  SessionLogEntry,
  SessionLogger,
} from '../packages/harness-orchestrator/src/sessionLogger.js';
import { turnContext } from '../packages/harness-orchestrator/src/turnContext.js';
import type {
  TurnHookContext,
  TurnHookPayload,
  TurnHookPoint,
  TurnHookRunner,
} from '../packages/harness-orchestrator/src/turnHooks.js';
import {
  REQUEST,
  doneOf,
  drain,
  registerWriteTool,
  scriptedModel,
  text,
  toolCalls,
  verifiedTurn,
} from './_helpers/replayTurnFixture.js';
import { approved, blocked, borderline } from './_helpers/verifierVerdictFixtures.js';

const INVOICE = { customer: 'K-1001', amount: 1200, currency: 'EUR' };
const OTHER_INVOICE = { customer: 'K-1001', amount: 1250, currency: 'EUR' };
const CREATED = 'Rechnung INV/2026/0042 über 1.200 EUR angelegt.';
/** The first answer states a wrong figure — the verdict blocks it. */
const WRONG = 'Die Rechnung INV/2026/0042 über 1.250 EUR ist angelegt.';
const CORRECTED = 'Die Rechnung INV/2026/0042 über 1.200 EUR ist angelegt.';
const SECOND = 'Rechnung INV/2026/0042 angelegt, Betrag 1.300 EUR.';
const PLAN = { channel: 'plan', payload: { step: 'finished' } };

interface HookCall {
  readonly point: TurnHookPoint;
  readonly ctx: TurnHookContext;
  readonly payload: TurnHookPayload;
}

/** Recording stand-ins for everything a turn persists or reports. */
function recorders() {
  const logged: SessionLogEntry[] = [];
  const sessionLogger = {
    log(entry: SessionLogEntry) {
      logged.push(entry);
      return Promise.resolve({ turnExternalId: `turn:scope-c07:${String(logged.length)}` });
    },
  } as unknown as SessionLogger;
  const facts: Array<{ turnId: string; assistantAnswer: string }> = [];
  const factExtractor = {
    extractAndIngest(input: { turnId: string; assistantAnswer: string }) {
      facts.push({ turnId: input.turnId, assistantAnswer: input.assistantAnswer });
      return Promise.resolve(0);
    },
  } as unknown as FactExtractor;
  const hooks: HookCall[] = [];
  const turnHookRegistry: TurnHookRunner = {
    run(point, ctx, payload) {
      hooks.push({ point, ctx, payload });
      return Promise.resolve(point === 'onAfterTurn' ? [PLAN] : []);
    },
  };
  return {
    logged,
    facts,
    hooks,
    options: { sessionLogger, factExtractor, turnHookRegistry },
    afterTurn: () => hooks.filter((h) => h.point === 'onAfterTurn'),
    beforeTurn: () => hooks.filter((h) => h.point === 'onBeforeTurn'),
  };
}

function invoiceTurn(
  responses: Parameters<typeof verifiedTurn>[0]['responses'],
  verdicts: Parameters<typeof verifiedTurn>[0]['verdicts'],
  extra: { readonly maxRetries?: number } = {},
) {
  const registry = new NativeToolRegistry();
  const invoice = registerWriteTool(registry, 'create_invoice', () => Promise.resolve(CREATED));
  const rec = recorders();
  const t = verifiedTurn({ registry, responses, verdicts, orchestrator: rec.options, ...extra });
  return { invoice, rec, t };
}

const run = (answer: string, input: unknown = INVOICE) => [
  toolCalls(['create_invoice', input]),
  text(answer),
];

describe('commit-on-delivery: a delivered re-entry is the request’s record', () => {
  it('MUTATION CHECK, chat(): a delivered correction retry is the logged answer', async () => {
    const { invoice, rec, t } = invoiceTurn([...run(WRONG), ...run(CORRECTED)], [blocked(), approved()]);

    const sa = await t.service.chat(REQUEST);

    assert.deepEqual(sa.verifier, { status: 'corrected' }, 'the retry was delivered');
    assert.deepEqual(invoice.inputs, [INVOICE], 'the write ran once');
    assert.deepEqual(
      rec.logged.map((e) => e.assistantAnswer),
      [CORRECTED],
      'one row, holding the delivered answer — not the contradicted one',
    );
    assert.deepEqual(rec.facts, [{ turnId: 'turn:scope-c07:1', assistantAnswer: CORRECTED }]);
    const [after] = rec.afterTurn();
    assert.equal(rec.afterTurn().length, 1, 'onAfterTurn fired once for the request');
    assert.equal(after?.payload.assistantAnswer, CORRECTED);
    assert.equal(after?.payload.turnExternalId, 'turn:scope-c07:1');
    assert.equal(
      after?.ctx.turnId,
      rec.beforeTurn()[0]?.ctx.turnId,
      'onAfterTurn runs in the hook context onBeforeTurn opened (the plan-runner keys on it)',
    );
  });

  it('MUTATION CHECK, stream: done names the delivered row and carries its annotation', async () => {
    const { rec, t } = invoiceTurn([...run(WRONG), ...run(CORRECTED)], [blocked(), approved()]);

    const events = await drain(t.service.chatStream(REQUEST));

    const terminal = doneOf(events);
    assert.equal(terminal?.answer, CORRECTED);
    assert.equal(terminal?.verifier?.badge, 'corrected');
    assert.deepEqual(rec.logged.map((e) => e.assistantAnswer), [CORRECTED]);
    assert.equal(terminal?.turnId, 'turn:scope-c07:1', 'save-as-memory reaches the delivered answer');
    const annotations = events.filter((e) => e.type === 'turn_annotation');
    assert.deepEqual(
      annotations.map((e) => (e.type === 'turn_annotation' ? e.payload : undefined)),
      [PLAN.payload],
      'the request’s onAfterTurn annotation goes out once',
    );
    assert.ok(
      events.findIndex((e) => e.type === 'turn_annotation') < events.findIndex((e) => e.type === 'done'),
      'before done',
    );
    assert.equal(rec.afterTurn()[0]?.payload.assistantAnswer, CORRECTED);
  });

  it('a resample, its contradiction and the retry: the third pass is the record', async () => {
    const { invoice, rec, t } = invoiceTurn(
      [...run(WRONG), ...run(SECOND), ...run(CORRECTED)],
      [borderline(), blocked(), approved()],
    );

    const sa = await t.service.chat(REQUEST);

    assert.equal(t.model.requests.length, 6, 'first run, resample and retry ran');
    assert.deepEqual(invoice.inputs, [INVOICE]);
    assert.deepEqual(sa.verifier, { status: 'corrected' });
    assert.deepEqual(rec.logged.map((e) => e.assistantAnswer), [CORRECTED]);
    assert.deepEqual(rec.facts.map((f) => f.assistantAnswer), [CORRECTED]);
  });

  it('a withheld answer records the pass its final verdict was about', async () => {
    const { rec, t } = invoiceTurn([...run(WRONG), ...run(SECOND)], [borderline(), blocked()], {
      maxRetries: 0,
    });

    const sa = await t.service.chat(REQUEST);

    assert.equal(sa.answerSource, 'verifier-blocked');
    assert.deepEqual(
      rec.logged.map((e) => e.assistantAnswer),
      [SECOND],
      'the resample the contradiction was found in — one row',
    );
  });

  it('an abandoned retry leaves the first run as the record', async () => {
    const { invoice, rec, t } = invoiceTurn(
      [...run(WRONG), toolCalls(['create_invoice', OTHER_INVOICE])],
      [blocked(), approved()],
    );

    const events = await drain(t.service.chatStream(REQUEST));

    assert.deepEqual(invoice.inputs, [INVOICE], 'the other invoice was never created');
    assert.equal(doneOf(events)?.answerSource, 'verifier-blocked');
    assert.deepEqual(rec.logged.map((e) => e.assistantAnswer), [WRONG]);
    assert.equal(doneOf(events)?.turnId, 'turn:scope-c07:1');
    assert.equal(
      events.some((e) => e.type === 'turn_annotation'),
      false,
      'a withheld turn releases none of its annotations',
    );
  });

  it('the record is written inside the delivered pass’s turn scope, as a pass writing it itself', async () => {
    const registry = new NativeToolRegistry();
    registerWriteTool(registry, 'create_invoice', () => Promise.resolve(CREATED));
    const rec = recorders();
    const writtenIn: Array<string | undefined> = [];
    const sessionLogger = {
      log(entry: SessionLogEntry) {
        writtenIn.push(turnContext.currentTurnId());
        return rec.options.sessionLogger.log(entry);
      },
    } as unknown as SessionLogger;
    // The turn each model request ran in: requests 0–1 are the first run,
    // 2–3 the retry.
    const model = scriptedModel([...run(WRONG), ...run(CORRECTED)]);
    const requestTurns: Array<string | undefined> = [];
    const base = model.provider as unknown as { complete: (req: LlmRequest) => Promise<unknown> };
    const provider = {
      ...(model.provider as object),
      complete: (req: LlmRequest) => {
        requestTurns.push(turnContext.currentTurnId());
        return base.complete(req);
      },
    } as unknown as LlmProvider;
    const t = verifiedTurn({
      registry,
      responses: [],
      verdicts: [blocked(), approved()],
      orchestrator: { ...rec.options, sessionLogger, provider },
    });

    await t.service.chat(REQUEST);

    assert.equal(requestTurns.length, 4);
    assert.notEqual(requestTurns[0], requestTurns[2], 'the retry is a pass of its own');
    assert.deepEqual(writtenIn, [requestTurns[2]], 'usage attribution and identity read the retry’s turn');
    assert.equal(rec.afterTurn()[0]?.ctx.turnId, requestTurns[0], 'onAfterTurn keeps the first run’s context');
  });

  it('control: an answer delivered on the first run is recorded as before', async () => {
    const { rec, t } = invoiceTurn(run(CORRECTED), [approved()]);

    const events = await drain(t.service.chatStream(REQUEST));

    assert.deepEqual(rec.logged.map((e) => e.assistantAnswer), [CORRECTED]);
    assert.equal(doneOf(events)?.turnId, 'turn:scope-c07:1');
    assert.equal(rec.afterTurn().length, 1);
    assert.equal(events.filter((e) => e.type === 'turn_annotation').length, 1);
  });

  it('control: shadow mode writes the row inside the turn, as before', async () => {
    const registry = new NativeToolRegistry();
    registerWriteTool(registry, 'create_invoice', () => Promise.resolve(CREATED));
    const rec = recorders();
    const t = verifiedTurn({
      registry,
      responses: run(WRONG),
      verdicts: [blocked()],
      mode: 'shadow',
      orchestrator: rec.options,
    });

    const events = await drain(t.service.chatStream(REQUEST));

    assert.deepEqual(rec.logged.map((e) => e.assistantAnswer), [WRONG]);
    assert.equal(doneOf(events)?.turnId, 'turn:scope-c07:1', 'no ledger bound: the turn persists itself');
    assert.equal(rec.afterTurn()[0]?.payload.turnExternalId, 'turn:scope-c07:1');
    assert.equal(events.at(-1)?.type, 'verifier', 'the verdict still trails the turn');
  });
});
