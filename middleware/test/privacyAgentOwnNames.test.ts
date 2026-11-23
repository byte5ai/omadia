/**
 * Spec 2042 follow-up — the speaking agent's own name is never masked in its
 * own turn. Live, C1 tagged "Dark Clippy" in the agent's recalled
 * self-introductions as a person; the model read "Ich bin <surrogate>" in its
 * history, "corrected" its own name, and the answer-side restore turned the
 * surrogate back into "Dark Clippy".
 *
 * Exact equality only: an agent "Mira" does not unmask "Mira Schulz".
 * Everything runs against the REAL service; values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  PrivacyGuardService,
  PrivacyPromptMaskRequest,
  PrivacyReplayedAnswerRequest,
  PromptPiiDetector,
  PromptPiiSpan,
} from '@omadia/plugin-api';
import { createPrivacyTurnHandle } from '@omadia/orchestrator/dist/privacyHandle.js';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

import { agentOwnNames } from '../packages/harness-orchestrator/src/buildOrchestrator.js';

const TURN = { sessionId: 's-own-name', turnId: 't-own-name' };
const AGENT = 'Dark Clippy';
const OWN_NAMES = ['Dark Clippy', 'clippy'];
const OTHER = 'Lukas Becker';

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

function serviceWith(...names: readonly string[]): PrivacyGuardService {
  return createPrivacyGuardService({
    c1Detector: namesC1(...names),
    readConfig: (key: string) => (key === 'mask_user_prompt' ? 'on' : undefined),
  });
}

describe('privacy-guard — the agent\'s own name in its own turn', () => {
  it('leaves the agent\'s own name in recalled context unmasked and unbooked', async () => {
    const svc = serviceWith(AGENT);
    const text = `Ich bin ${AGENT}, ein KI-Agent.`;
    const result = await svc.maskReplayedAnswer!({ ...TURN, text, ownNames: OWN_NAMES });
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.equal(result.maskedText, text);
    assert.deepEqual(result.spans, []);
    const receipt = await svc.finalizeTurn(TURN.turnId);
    assert.equal(receipt?.maskedContextSpans, undefined, 'no context span is booked');
  });

  it('masks the same name without ownNames (the behaviour before the fix)', async () => {
    const svc = serviceWith(AGENT);
    const text = `Ich bin ${AGENT}, ein KI-Agent.`;
    const result = await svc.maskReplayedAnswer!({ ...TURN, text });
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.ok(!result.maskedText.includes(AGENT), result.maskedText);
    assert.deepEqual(result.spans.map((s) => s.type), ['person']);
  });

  it('still masks another person\'s name next to the agent\'s own', async () => {
    const svc = serviceWith(AGENT, OTHER);
    const text = `Ich bin ${AGENT}. Frag ${OTHER}`;
    const result = await svc.maskReplayedAnswer!({ ...TURN, text, ownNames: OWN_NAMES });
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.ok(result.maskedText.startsWith(`Ich bin ${AGENT}. Frag `), result.maskedText);
    assert.ok(!result.maskedText.includes(OTHER), result.maskedText);
    assert.equal(result.spans.length, 1);
  });

  it('exempts the name with trailing punctuation and in another case', async () => {
    // The C1 span itself carries the period here; extension or not, the value
    // must still compare equal.
    const svc = createPrivacyGuardService({
      c1Detector: {
        id: 'c1-test',
        async detect(text: string): Promise<readonly PromptPiiSpan[]> {
          const at = text.indexOf('Dark Clippy.');
          return [{ start: at, end: at + 'Dark Clippy.'.length, type: 'person', confidence: 0.99 }];
        },
      },
    });
    const text = 'Hier spricht Dark Clippy.';
    const result = await svc.maskReplayedAnswer!({ ...TURN, text, ownNames: ['dark clippy'] });
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.equal(result.maskedText, text);
  });

  it('does not exempt a longer name that only contains an own name', async () => {
    const svc = serviceWith('Mira Schulz');
    const result = await svc.maskReplayedAnswer!({
      ...TURN,
      text: 'Frag Mira Schulz',
      ownNames: ['Mira'],
    });
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.ok(!result.maskedText.includes('Mira'), result.maskedText);
  });

  it('ignores own names shorter than two characters', async () => {
    const svc = serviceWith('K');
    const result = await svc.maskReplayedAnswer!({ ...TURN, text: 'Gruß, K', ownNames: ['K', ' '] });
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.ok(!result.maskedText.endsWith(', K'), result.maskedText);
  });

  it('leaves the agent\'s name in the user\'s message unmasked', async () => {
    const svc = serviceWith(AGENT, OTHER);
    const result = await svc.maskUserPrompt!({
      ...TURN,
      text: `Hallo ${AGENT}, was macht ${OTHER}?`,
      ownNames: OWN_NAMES,
    });
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.ok(result.maskedText.startsWith(`Hallo ${AGENT}, was macht `), result.maskedText);
    assert.ok(!result.maskedText.includes(OTHER), result.maskedText);
  });
});

describe('PrivacyTurnHandle — the agent\'s own names', () => {
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

  it('passes the names on both the prompt and the recalled-context path', async () => {
    const prompts: PrivacyPromptMaskRequest[] = [];
    const replays: PrivacyReplayedAnswerRequest[] = [];
    const handle = createPrivacyTurnHandle({
      service: stubService({
        maskUserPrompt: async (request) => {
          prompts.push(request);
          return { outcome: 'disabled' };
        },
        maskReplayedAnswer: async (request) => {
          replays.push(request);
          return { outcome: 'disabled' };
        },
      }),
      sessionId: 's',
      turnId: 't',
      ownNames: OWN_NAMES,
    });
    await handle.maskUserPrompt('Hallo', { origin: 'message' });
    await handle.maskReplayedAnswer?.('Ich bin Dark Clippy', ['Ich bin Dark Clippy']);
    assert.deepEqual(prompts.map((r) => r.ownNames), [OWN_NAMES]);
    assert.deepEqual(replays.map((r) => r.ownNames), [OWN_NAMES]);
  });

  it('sends no ownNames field without names', async () => {
    let seen: PrivacyReplayedAnswerRequest | undefined;
    const handle = createPrivacyTurnHandle({
      service: stubService({
        maskReplayedAnswer: async (request) => {
          seen = request;
          return { outcome: 'disabled' };
        },
      }),
      sessionId: 's',
      turnId: 't',
      ownNames: [],
    });
    await handle.maskReplayedAnswer?.('x');
    assert.deepEqual(seen, { sessionId: 's', turnId: 't', text: 'x' });
  });

  it('derives the names from the agent speaker, as the identity guard does', () => {
    assert.deepEqual(agentOwnNames({ displayName: 'Dark Clippy', slug: 'clippy' }, ' Dark Clippy '), [
      'Dark Clippy',
      'clippy',
    ]);
    assert.deepEqual(agentOwnNames({ displayName: 'Mira', slug: 'mira' }, 'Mira H.'), [
      'Mira',
      'mira',
      'Mira H.',
    ]);
  });
});
