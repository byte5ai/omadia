/**
 * #2341 — a channel replays the agent's own earlier answer as `priorTurns`;
 * it reaches the model masked (names the agent wrote come back as
 * pseudonyms). Without a word on why, the model "corrected" a correct
 * earlier answer. The turn's system hint now carries a data-free kernel note
 * whenever a replayed answer was masked, and only then.
 *
 * Real `Orchestrator` and real privacy-guard service over a scripted model;
 * the names are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmRequest } from '@omadia/llm-provider';
import type { PromptPiiDetector, PromptPiiSpan } from '@omadia/plugin-api';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

import type { ChatTurnInput } from '../../packages/harness-channel-sdk/src/chatAgent.js';
import { REPLAYED_ANSWER_MASKED_NOTE } from '../../packages/harness-orchestrator/src/replayedAnswerNote.js';
import { REQUEST, drain, text, verifiedTurn } from '../_helpers/replayTurnFixture.js';
import { approved } from '../_helpers/verifierVerdictFixtures.js';

const NAME = 'Gaius Beispielius';

function namesC1(...names: readonly string[]): PromptPiiDetector {
  return {
    id: 'c1-test',
    async detect(body: string): Promise<readonly PromptPiiSpan[]> {
      const spans: PromptPiiSpan[] = [];
      for (const name of names) {
        for (let at = body.indexOf(name); at >= 0; at = body.indexOf(name, at + name.length)) {
          spans.push({ start: at, end: at + name.length, type: 'person', confidence: 0.99 });
        }
      }
      return spans;
    },
  };
}

function inputWithReplay(answer: string): ChatTurnInput {
  return {
    ...REQUEST,
    userMessage: 'Erstelle mir bitte eine Tabelle mit drei Zeilen.',
    priorTurns: [{ userMessage: 'Erzähl mir etwas über die Stadtgeschichte.', assistantAnswer: answer }],
  };
}

function systemText(request: LlmRequest | undefined): string {
  return JSON.stringify((request as { system?: unknown } | undefined)?.system ?? '');
}

function guardedTurn() {
  const service = createPrivacyGuardService({ c1Detector: namesC1(NAME) });
  return verifiedTurn({
    responses: [text('Hier ist die Tabelle.')],
    verdicts: [approved()],
    mode: 'shadow',
    orchestrator: { privacyGuard: () => service },
  });
}

const NOTE_HEAD = JSON.stringify(REPLAYED_ANSWER_MASKED_NOTE.split('\n')[0]).slice(1, -1);

describe('a masked replayed answer comes with a kernel note (#2341)', () => {
  it('buffered: the note is in the system hint, the name is not on the wire', async () => {
    const t = guardedTurn();
    await t.orchestrator.runTurn(inputWithReplay(`Die Stadt gründete ${NAME} im Jahr 50.`));
    const first = t.model.requests[0];
    assert.ok(systemText(first).includes(NOTE_HEAD), 'kernel note missing');
    assert.equal(JSON.stringify(first).includes(NAME), false, 'the replayed name reached the model');
  });

  it('streaming: the same note', async () => {
    const t = guardedTurn();
    await drain(t.orchestrator.chatStream(inputWithReplay(`Die Stadt gründete ${NAME} im Jahr 50.`)));
    assert.ok(systemText(t.model.requests[0]).includes(NOTE_HEAD));
  });

  it('a replayed answer with nothing masked gets no note', async () => {
    const t = guardedTurn();
    await t.orchestrator.runTurn(inputWithReplay('Die Stadt ist alt und liegt am Fluss.'));
    assert.equal(systemText(t.model.requests[0]).includes(NOTE_HEAD), false);
  });
});
