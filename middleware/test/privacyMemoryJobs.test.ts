/**
 * WP-10 — the memory jobs of `@omadia/orchestrator-extras` send stored text,
 * which holds real values, through the extras' own provider. With a privacy
 * guard installed that text is masked whatever `mask_user_prompt` says:
 *
 * - a job that runs INSIDE a turn (the recall relevance judge) masks its
 *   request through the turn's privacy handle, with the always-on replay mask
 *   (`maskReplayedAnswer`), never through the flag-gated prompt mask, so the
 *   spans are booked as the turn's own egress;
 * - `blocked`, or a handle that cannot mask, skips the job for that turn: no
 *   provider call, the cheap recall legs win;
 * - without a privacy guard the job keeps today's behaviour.
 *
 * Everything runs against the REAL privacy-guard service; values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PrivacyPromptMaskResult } from '@omadia/plugin-api';
import { createRecallRelevanceJudge } from '@omadia/orchestrator-extras';
import type { RecallCandidate } from '@omadia/orchestrator-extras';
import {
  createJobPrivacy,
  createRequestMasker,
} from '@omadia/orchestrator-extras/dist/jobPrivacy.js';
import type { TurnPrivacyContext } from '@omadia/orchestrator-extras/dist/jobPrivacy.js';
import { createPrivacyTurnHandle } from '@omadia/orchestrator/dist/privacyHandle.js';
import type { PrivacyTurnHandle } from '@omadia/orchestrator/dist/privacyHandle.js';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

const MAIL = 'jana.beispiel@firma.example';
const NAME = 'Jana Beispielfrau';
const SURROGATE_MAIL = /\S+@example\.net/;
const CANDIDATES: readonly RecallCandidate[] = [
  { id: 'plan-1', kind: 'plan', text: `Rückruf bei ${NAME} (${MAIL}) zur Rechnung 1.234,56 EUR` },
  { id: 'insight-1', kind: 'insight', text: 'Allgemeine Notiz ohne Bezug' },
];
const USER_MESSAGE = 'Wann rufe ich wegen der Rechnung zurück?';

interface RecordingLlm {
  readonly calls: unknown[];
  readonly llm: never;
}

/** A provider that records every request and answers with `reply`. */
function recordingLlm(reply: string): RecordingLlm {
  const calls: unknown[] = [];
  const llm = {
    async complete(request: unknown) {
      calls.push(request);
      return { content: [{ type: 'text', text: reply }] };
    },
  };
  return { calls, llm: llm as never };
}

/** The privacy guard with the operator deny-list naming NAME and prompt
 *  masking left at its shipped default (off). */
function guardWithDenyList() {
  return createPrivacyGuardService({
    readConfig: (key) => (key === 'custom_terms' ? NAME : undefined),
  });
}

function inTurn(handle: Pick<PrivacyTurnHandle, 'maskReplayedAnswer'>): () => TurnPrivacyContext {
  return () => ({ current: () => ({ privacyHandle: handle }) });
}

const outsideAnyTurn = (): TurnPrivacyContext => ({ current: () => undefined });

function judgeWith(
  llm: never,
  turnContext: () => TurnPrivacyContext | undefined,
  resolveGuard: Parameters<typeof createJobPrivacy>[0],
  logs: string[] = [],
) {
  return createRecallRelevanceJudge({
    llm,
    model: 'fast-model',
    verdictCacheMax: 0,
    log: (msg) => {
      logs.push(msg);
    },
    maskRequest: createRequestMasker({
      turnContext,
      openJob: createJobPrivacy(resolveGuard),
      job: 'recall-judge',
    }),
  });
}

describe('recall relevance judge — in a turn, through the turn handle', () => {
  it('masks a stored e-mail and a deny-listed name with mask_user_prompt off, booked as turn egress', async () => {
    const service = guardWithDenyList();
    const handle = createPrivacyTurnHandle({ service, sessionId: 's-jobs', turnId: 't-judge' });
    const provider = recordingLlm('{"relevant":["plan-1"]}');
    const judge = judgeWith(provider.llm, inTurn(handle), () => service);

    const kept = await judge.filterRelevant(USER_MESSAGE, CANDIDATES);

    assert.deepEqual([...kept], ['plan-1']);
    assert.equal(provider.calls.length, 1);
    const wire = JSON.stringify(provider.calls[0]);
    assert.ok(!wire.includes(MAIL), wire);
    assert.ok(!wire.includes(NAME), wire);
    assert.match(wire, SURROGATE_MAIL);
    // Identity shapes only: the amount stays readable for the judge.
    assert.ok(wire.includes('1.234,56 EUR'), wire);
    // Through the turn's map, so the receipt books the spans as the turn's own egress.
    const receipt = await handle.finalize();
    assert.equal(receipt?.maskedPromptSpans?.length, 2, JSON.stringify(receipt));
    assert.ok(receipt?.maskedPromptSpans?.some((s) => s.type === 'email'), JSON.stringify(receipt));
  });

  it('skips the judge without a provider call when the turn handle blocks', async () => {
    const provider = recordingLlm('{"relevant":[]}');
    const logs: string[] = [];
    const blocking = {
      async maskReplayedAnswer(): Promise<PrivacyPromptMaskResult> {
        return { outcome: 'blocked', reason: 'prompt PII detection failed' };
      },
    };
    const judge = judgeWith(provider.llm, inTurn(blocking), () => guardWithDenyList(), logs);

    const kept = await judge.filterRelevant(USER_MESSAGE, CANDIDATES);

    assert.equal(provider.calls.length, 0);
    // Skipping the judge keeps every candidate the cheap legs surfaced.
    assert.deepEqual([...kept].sort(), ['insight-1', 'plan-1']);
    assert.ok(
      logs.some((l) => l.includes('[recall-judge]') && l.includes('prompt PII detection failed')),
      JSON.stringify(logs),
    );
  });

  it('never falls back to the flag-gated prompt mask: a handle without maskReplayedAnswer skips the judge', async () => {
    const provider = recordingLlm('{"relevant":[]}');
    let promptMaskCalls = 0;
    const legacyHandle = {
      async maskUserPrompt(): Promise<PrivacyPromptMaskResult> {
        promptMaskCalls += 1;
        return { outcome: 'disabled' };
      },
    };
    const judge = judgeWith(provider.llm, inTurn(legacyHandle), () => guardWithDenyList());

    const kept = await judge.filterRelevant(USER_MESSAGE, CANDIDATES);

    assert.equal(provider.calls.length, 0);
    assert.equal(promptMaskCalls, 0);
    assert.equal(kept.size, CANDIDATES.length);
  });

  it('skips the judge when the handle reports `disabled` (an older provider with the flag off)', async () => {
    const provider = recordingLlm('{"relevant":[]}');
    const olderProvider = {
      async maskReplayedAnswer(): Promise<PrivacyPromptMaskResult> {
        return { outcome: 'disabled' };
      },
    };
    const judge = judgeWith(provider.llm, inTurn(olderProvider), () => guardWithDenyList());

    await judge.filterRelevant(USER_MESSAGE, CANDIDATES);

    assert.equal(provider.calls.length, 0);
  });
});

describe('recall relevance judge — without a privacy guard', () => {
  it("keeps today's behaviour: the stored text reaches the provider as stored", async () => {
    const provider = recordingLlm('{"relevant":["plan-1"]}');
    const judge = judgeWith(provider.llm, outsideAnyTurn, () => undefined);

    const kept = await judge.filterRelevant(USER_MESSAGE, CANDIDATES);

    assert.deepEqual([...kept], ['plan-1']);
    assert.equal(provider.calls.length, 1);
    assert.ok(JSON.stringify(provider.calls[0]).includes(MAIL));
  });
});
