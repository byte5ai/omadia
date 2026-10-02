/**
 * Replayed assistant answers on their way to the model:
 * `PrivacyGuardService.maskReplayedAnswer` and the turn handle that carries it
 * to the orchestrator.
 *
 * Teams and Telegram replay the answer they delivered as `priorTurns`, and an
 * answer `v4_render_answer` materialized server-side carries real values the
 * turn's model never saw. So a replayed answer is masked whatever
 * `mask_user_prompt` says (that flag is about the user's own words): identity
 * shapes, the operator deny-list and C1 when configured, through the turn's
 * surrogate map so the answer-side restore covers it, booked as the turn's own
 * egress.
 *
 * Everything runs against the REAL service; values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  PrivacyGuardService,
  PromptPiiDetector,
  PromptPiiSpan,
} from '@omadia/plugin-api';
import { createPrivacyTurnHandle } from '@omadia/orchestrator/dist/privacyHandle.js';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import { findIdentityLeaks } from '@omadia/plugin-privacy-guard/dist/v4/onTheWire.js';

const TURN = { sessionId: 's-replay', turnId: 't-replay' };
const MAIL = 'jana.beispiel@firma.example';
const NAME = 'Jana Beispielfrau';
const SURROGATE_MAIL = /\S+@example\.net/;
/** An answer the shield rendered, as a channel stores and replays it. */
const RENDERED =
  `Ansprechpartnerin ist ${NAME}, erreichbar unter ${MAIL} oder im Büro. ` +
  'Offen ist die Rechnung über 1.234,56 EUR vom 01.03.2026';

/** A C1 stand-in that finds the given names, as the GLiNER sidecar would. */
function namesC1(...names: readonly string[]): PromptPiiDetector {
  return {
    id: 'c1-test',
    async detect(text: string): Promise<readonly PromptPiiSpan[]> {
      const spans: PromptPiiSpan[] = [];
      for (const name of names) {
        for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + name.length)) {
          spans.push({ start: at, end: at + name.length, type: 'person', confidence: 0.99 });
        }
      }
      return spans;
    },
  };
}

describe('privacy-guard — replayed assistant answers', () => {
  it('masks identity values with mask_user_prompt off (the shipped default)', async () => {
    const svc = createPrivacyGuardService();
    // The user's own words follow the flag: off, so untouched.
    assert.deepEqual(await svc.maskUserPrompt!({ ...TURN, text: RENDERED }), {
      outcome: 'disabled',
    });

    const result = await svc.maskReplayedAnswer!({ ...TURN, text: RENDERED });

    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.deepEqual(findIdentityLeaks(result.maskedText, [MAIL]), []);
    assert.match(result.maskedText, SURROGATE_MAIL);
    // Identity shapes only: amounts and dates stay, as in a v4 digest.
    assert.ok(result.maskedText.includes('1.234,56 EUR'), result.maskedText);
    assert.ok(result.maskedText.includes('01.03.2026'), result.maskedText);
    assert.equal(result.degraded, false);
    assert.deepEqual(
      result.spans.map((s) => s.type),
      ['email'],
    );
  });

  it('restores through the turn map and books the spans as the turn\'s own egress', async () => {
    const svc = createPrivacyGuardService();
    const masked = await svc.maskReplayedAnswer!({ ...TURN, text: `Kontakt: ${MAIL} bitte` });
    assert.equal(masked.outcome, 'masked');
    if (masked.outcome !== 'masked') return;
    const surrogate = SURROGATE_MAIL.exec(masked.maskedText)?.[0];
    assert.ok(surrogate, masked.maskedText);

    // The model writes the placeholder back; the user reads the real value.
    assert.equal(
      await svc.restorePromptPseudonyms!(TURN.turnId, `Ich schreibe an ${surrogate} heute`),
      `Ich schreibe an ${MAIL} heute`,
    );
    const receipt = await svc.finalizeTurn(TURN.turnId);
    assert.ok(receipt, 'a turn whose only masking was a replayed answer still gets a receipt');
    assert.deepEqual(
      receipt.maskedPromptSpans?.map((s) => s.type),
      ['email'],
    );
    assert.equal(receipt.verifierEgress, undefined, 'a replayed answer is no verifier request');
  });

  it('shares one placeholder with the masked prompt when mask_user_prompt is on', async () => {
    const svc = createPrivacyGuardService({
      readConfig: (key: string) => (key === 'mask_user_prompt' ? 'on' : undefined),
    });
    const prompt = await svc.maskUserPrompt!({ ...TURN, text: `Schreib an ${MAIL} bitte` });
    const answer = await svc.maskReplayedAnswer!({
      ...TURN,
      text: `Notiert, ${MAIL} ist die Adresse`,
    });
    assert.equal(prompt.outcome, 'masked');
    assert.equal(answer.outcome, 'masked');
    if (prompt.outcome !== 'masked' || answer.outcome !== 'masked') return;
    const surrogate = SURROGATE_MAIL.exec(prompt.maskedText)?.[0];
    assert.ok(surrogate, prompt.maskedText);
    assert.ok(answer.maskedText.includes(surrogate), answer.maskedText);
  });

  it('masks names through C1 and terms on the operator deny-list, with the flag off', async () => {
    const svc = createPrivacyGuardService({
      readConfig: (key: string) => (key === 'custom_terms' ? 'Projekt Apfel' : undefined),
      c1Detector: namesC1(NAME),
    });
    const result = await svc.maskReplayedAnswer!({
      ...TURN,
      text: `${NAME} leitet Projekt Apfel und sonst nichts`,
    });
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.deepEqual(findIdentityLeaks(result.maskedText, [NAME, 'Projekt Apfel']), []);
    assert.deepEqual(
      result.spans.map((s) => s.type).sort(),
      ['custom', 'person'],
    );
    const restored = await svc.restorePromptPseudonyms!(TURN.turnId, result.maskedText);
    assert.equal(restored, `${NAME} leitet Projekt Apfel und sonst nichts`);
  });

  it('degrades to the baseline when C1 fails, instead of blocking the replay', async () => {
    const svc = createPrivacyGuardService({
      c1Detector: {
        id: 'c1-down',
        detect: async () => {
          throw new Error('sidecar unreachable');
        },
      },
    });
    const result = await svc.maskReplayedAnswer!({ ...TURN, text: RENDERED });
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.equal(result.degraded, true);
    assert.deepEqual(findIdentityLeaks(result.maskedText, [MAIL]), []);
  });

  it('blocks when a detector fails inside the masking pass', async (t) => {
    const svc = createPrivacyGuardService({
      readConfig: (key: string) => (key === 'custom_patterns' ? 'PRJ-\\d{4}' : undefined),
    });
    // The first call builds the deny-list detector (pattern vetting reads the
    // clock, so the clock is faked only afterwards) and masks as usual.
    const first = await svc.maskReplayedAnswer!({ ...TURN, text: 'Ticket PRJ-1234 ist erledigt' });
    assert.equal(first.outcome, 'masked');

    // An operator pattern over its runtime budget throws mid-pass
    // (`CustomPatternRuntimeError`). The answer must not go out unmasked.
    let now = Date.now();
    t.mock.method(Date, 'now', () => (now += 1_000));
    const result = await svc.maskReplayedAnswer!({
      ...TURN,
      text: `Kontakt ${MAIL} zu PRJ-1234`,
    });
    assert.equal(result.outcome, 'blocked');
  });
});

describe('PrivacyTurnHandle — replayed answers', () => {
  function stubService(overrides: Partial<PrivacyGuardService>): PrivacyGuardService {
    return {
      internToolResultV4: async () => ({ digestText: '', datasetId: 'ds' }),
      recordBypassedTool: async () => undefined,
      runV4Tool: async () => ({ resultText: '' }),
      subAgentResultV4: async () => ({ resultText: '' }),
      takeRenderedAnswerV4: async () => undefined,
      v4ToolSpecs: () => [],
      finalizeTurn: async () => undefined,
      ...overrides,
    };
  }

  it('scopes the request to the handle turn/session pair', async () => {
    let seen: { sessionId: string; turnId: string; text: string } | undefined;
    const handle = createPrivacyTurnHandle({
      service: stubService({
        maskReplayedAnswer: async (request) => {
          seen = request;
          return { outcome: 'masked', maskedText: 'X', spans: [], degraded: false };
        },
        maskUserPrompt: async () => {
          throw new Error('a replayed answer must not take the prompt path');
        },
      }),
      sessionId: 'session-1',
      turnId: 'turn-1',
    });
    assert.deepEqual(await handle.maskReplayedAnswer?.('answer'), {
      outcome: 'masked',
      maskedText: 'X',
      spans: [],
      degraded: false,
    });
    assert.deepEqual(seen, { sessionId: 'session-1', turnId: 'turn-1', text: 'answer' });
  });

  it('falls back to maskUserPrompt for a provider that predates the member', async () => {
    const prompts: string[] = [];
    const legacy = createPrivacyTurnHandle({
      service: stubService({
        maskUserPrompt: async (request) => {
          prompts.push(request.text);
          return { outcome: 'blocked', reason: 'test' };
        },
      }),
      sessionId: 's',
      turnId: 't',
    });
    assert.deepEqual(await legacy.maskReplayedAnswer?.('answer'), {
      outcome: 'blocked',
      reason: 'test',
    });
    assert.deepEqual(prompts, ['answer']);

    // A provider with neither member passes the text, as before both existed.
    const bare = createPrivacyTurnHandle({ service: stubService({}), sessionId: 's', turnId: 't' });
    assert.deepEqual(await bare.maskReplayedAnswer?.('answer'), { outcome: 'disabled' });
  });
});
