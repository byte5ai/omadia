/**
 * Spec 2042 §5.14, §6 criterion 29 — "the trace, verification and consulted
 * agents are reachable in details or by asking". The answer carries its turn
 * id (the trace reference) into its details; the kernel records the details
 * of each answer the user received and hands them to the agent's next turn,
 * so "wie weißt du das?" is answered from the harness's record. No value
 * (masked or restored) reaches that note, and the message body is unchanged.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildAnswerDetails,
  toSemanticAnswer,
  type ChatAgent,
  type ChatStreamEvent,
  type ChatTurnInput,
  type SemanticAnswer,
  type VerifierResultSummary,
} from '@omadia/channel-sdk';
import { SYSTEM_SPEAKER, type AgentSpeaker } from '@omadia/plugin-api';

import {
  AnswerDetailsMemory,
  withAnswerDetailsNote,
  withAnswerDetailsRecall,
} from '../packages/harness-orchestrator/src/answerDetailsRecall.js';
import { answerWithheldText } from '../packages/harness-orchestrator/src/discretion/disclosure.js';
import { buildSystemNotice } from '../packages/harness-orchestrator/src/management/systemNotices.js';
import { withCorrectionHint } from '../packages/harness-orchestrator/src/verifierEnforceStream.js';

/** Both halves as the kernel composes them (recorder outside, note inside). */
function recalling(agent: ChatAgent, memory = new AnswerDetailsMemory()): ChatAgent {
  return withAnswerDetailsRecall(withAnswerDetailsNote(agent, memory), memory);
}

const mira: AgentSpeaker = { kind: 'agent', agentId: 'id-mira', slug: 'mira', displayName: 'Mira' };
const verified: VerifierResultSummary = {
  badge: 'verified',
  status: 'approved',
  claimCount: 2,
  contradictionCount: 0,
  unverifiedCount: 0,
  retryCount: 0,
  latencyMs: 5,
  mode: 'shadow',
};

/** An agent that records the inputs it saw and answers from a script. */
function scripted(answers: SemanticAnswer[]): { agent: ChatAgent; inputs: ChatTurnInput[] } {
  const inputs: ChatTurnInput[] = [];
  let i = 0;
  const agent: ChatAgent = {
    chat: (input) => {
      inputs.push(input);
      return Promise.resolve(answers[Math.min(i++, answers.length - 1)] ?? { text: '' });
    },
    chatStream: () => {
      throw new Error('not used');
    },
  };
  return { agent, inputs };
}

describe('criterion 29 — trace reference in the answer details', () => {
  it('toSemanticAnswer forwards the turn id; the details carry it as the trace reference', () => {
    const answer = toSemanticAnswer({ answer: 'Es sind 3 Rechnungen offen.', toolCalls: 1, iterations: 1, turnId: 'turn:tab_1:2026' });
    assert.equal(answer.turnId, 'turn:tab_1:2026');
    assert.equal(answer.text.includes('turn:'), false, 'never in the body');
    const details = buildAnswerDetails({ ...answer, verifier: { status: 'verified' } });
    assert.deepEqual(details?.trace, { turnId: 'turn:tab_1:2026' });
  });

  it('a trace reference alone does not open a details element', () => {
    assert.equal(buildAnswerDetails({ text: 'Hallo', speaker: mira, turnId: 'turn:x' }), undefined);
  });
});

describe('criterion 29 — "how do you know?" reaches the previous answer\'s details', () => {
  it('the next turn of the same conversation gets the record; the body is untouched', async () => {
    const first: SemanticAnswer = {
      text: 'Es sind 3 Rechnungen offen, Kunde Müller AG.',
      speaker: mira,
      turnId: 'turn:tab_1:1',
      verifier: { status: 'verified' },
      maskedValues: ['Müller AG'],
      answerSource: 'privacy-render',
      privacyReceipt: { datasetsInterned: 1, fieldsMasked: 4, fieldsCleartext: 0, verbsExecuted: [], pseudonymProjectionUsed: false },
      contributions: [{ id: 'c1', speaker: { kind: 'agent', agentId: 'id-jonas', slug: 'jonas', displayName: 'Jonas' }, text: 'ok', status: 'delivered' }],
    };
    const { agent, inputs } = scripted([first, { text: 'Weil …', speaker: mira }]);
    const recalled = recalling(agent);
    const out = await recalled.chat({ userMessage: 'Welche Rechnungen sind offen?', sessionScope: 'tab_1' });
    assert.equal(out, first, 'the answer itself is passed on unchanged');
    assert.equal(inputs[0]?.extraSystemHint, undefined, 'nothing to recall on the first turn');

    await recalled.chat({ userMessage: 'Wie weißt du das?', sessionScope: 'tab_1' });
    const hint = inputs[1]?.extraSystemHint ?? '';
    assert.match(hint, /previous answer/);
    assert.match(hint, /All claims checked\./);
    assert.match(hint, /source system/);
    assert.match(hint, /Jonas contributed/);
    assert.match(hint, /4 fields were masked/);
    assert.match(hint, /Trace reference: turn:tab_1:1/);
    assert.equal(hint.includes('Müller'), false, 'no value reaches the note');
    assert.equal(hint.includes('Rechnungen'), false, 'not the answer text either');
  });

  it('keeps a verifier retry hint and appends the record after it', async () => {
    const { agent, inputs } = scripted([{ text: 'a', speaker: mira, turnId: 't1' }]);
    const recalled = recalling(agent);
    await recalled.chat({ userMessage: 'x', sessionScope: 's' });
    await recalled.chat({ userMessage: 'y', sessionScope: 's', extraSystemHint: 'Correct claim 2.' });
    const hint = inputs[1]?.extraSystemHint ?? '';
    assert.ok(hint.startsWith('Correct claim 2.'));
    assert.match(hint, /No fact check settled a claim/);
    assert.match(hint, /Trace reference: t1/);
  });

  it('a withheld answer (system notice) records nothing; conversations stay apart', async () => {
    const memory = new AnswerDetailsMemory();
    const { agent, inputs } = scripted([
      { text: 'a', speaker: mira, verifier: { status: 'verified' } },
      { text: 'Ich kann das nicht sagen.', speaker: SYSTEM_SPEAKER },
      { text: 'b', speaker: mira },
    ]);
    const recalled = recalling(agent, memory);
    await recalled.chat({ userMessage: '1', sessionScope: 's1' });
    await recalled.chat({ userMessage: '2', sessionScope: 's1' });
    assert.match(inputs[1]?.extraSystemHint ?? '', /All claims checked/);
    await recalled.chat({ userMessage: '3', sessionScope: 's1' });
    assert.equal(inputs[2]?.extraSystemHint, undefined, 'a withheld answer has nothing to explain');
    assert.equal(memory.get('s2'), undefined);
  });

  it('an answer refused by discretion records nothing, though it carries the agent as speaker', async () => {
    const memory = new AnswerDetailsMemory();
    const { agent, inputs } = scripted([
      { text: 'a', speaker: mira, verifier: { status: 'verified' } },
      { text: answerWithheldText('de'), speaker: mira, verifier: { status: 'verified' } },
      { text: 'b', speaker: mira },
    ]);
    const recalled = recalling(agent, memory);
    await recalled.chat({ userMessage: '1', sessionScope: 's1' });
    await recalled.chat({ userMessage: '2', sessionScope: 's1' });
    await recalled.chat({ userMessage: '3', sessionScope: 's1' });
    assert.equal(inputs[2]?.extraSystemHint, undefined, 'nothing about the refused turn reaches the next one');
  });

  it('streaming: the record follows done and a trailing shadow verdict', async () => {
    const inputs: ChatTurnInput[] = [];
    const agent: ChatAgent = {
      chat: () => Promise.reject(new Error('not used')),
      async *chatStream(input): AsyncGenerator<ChatStreamEvent> {
        inputs.push(input);
        yield { type: 'text_delta', text: 'Drei.' };
        yield { type: 'done', answer: 'Drei.', toolCalls: 1, iterations: 1, turnId: 'turn:s:1' };
        yield { type: 'verifier', summary: verified };
      },
    };
    const recalled = recalling(agent);
    const seen: string[] = [];
    for await (const ev of recalled.chatStream({ userMessage: 'Wie viele?', sessionScope: 's' })) seen.push(ev.type);
    assert.deepEqual(seen, ['text_delta', 'done', 'verifier'], 'every event passes unchanged');
    for await (const _ of recalled.chatStream({ userMessage: 'Wie weißt du das?', sessionScope: 's' })) void _;
    const hint = inputs[1]?.extraSystemHint ?? '';
    assert.match(hint, /All claims checked/);
    assert.match(hint, /Trace reference: turn:s:1/);
  });

  it('streaming: an identity-guard withheld done records nothing', async () => {
    const inputs: ChatTurnInput[] = [];
    let n = 0;
    const agent: ChatAgent = {
      chat: () => Promise.reject(new Error('not used')),
      async *chatStream(input): AsyncGenerator<ChatStreamEvent> {
        inputs.push(input);
        n += 1;
        yield n === 1
          ? {
              type: 'done',
              answer: 'Teil.\n\nHinweis',
              toolCalls: 0,
              iterations: 1,
              systemNotice: buildSystemNotice('identity_guard_blocked', { agent: { slug: 'mira', displayName: 'Mira', agentId: 'id-mira' } }),
            }
          : { type: 'done', answer: 'ok', toolCalls: 0, iterations: 1 };
      },
    } as ChatAgent;
    const recalled = recalling(agent);
    for await (const _ of recalled.chatStream({ userMessage: '1', sessionScope: 's' })) void _;
    for await (const _ of recalled.chatStream({ userMessage: '2', sessionScope: 's' })) void _;
    assert.equal(inputs[1]?.extraSystemHint, undefined);
  });

  it('a fast-lane answer (a table from the source system) is recorded as system data, not denied', async () => {
    const { agent, inputs } = scripted([
      { text: '1 offener Posten.', speaker: mira, data: [{ kind: 'table', columns: ['Nr'], rows: [['RE-1']] }] },
    ]);
    const recalled = recalling(agent);
    await recalled.chat({ userMessage: '1', sessionScope: 's' });
    await recalled.chat({ userMessage: 'Woher?', sessionScope: 's' });
    const hint = inputs[1]?.extraSystemHint ?? '';
    assert.match(hint, /source system/);
    assert.equal(hint.includes('No source-system data'), false);
    assert.equal(hint.includes('RE-1'), false);
  });

  it('internal helpers are counted, never named; no line repeats', async () => {
    const { agent, inputs } = scripted([
      { text: 'a', speaker: mira, agentsConsulted: [{ agentId: 'ask_controlling', label: 'Controlling', status: 'success' }] },
    ]);
    const recalled = recalling(agent);
    await recalled.chat({ userMessage: '1', sessionScope: 's' });
    await recalled.chat({ userMessage: '2', sessionScope: 's' });
    const hint = inputs[1]?.extraSystemHint ?? '';
    assert.match(hint, /1 internal helper run\(s\) worked on it/);
    assert.equal(/controlling/i.test(hint), false);
    assert.equal(hint.split('No fact check settled a claim').length, 2, 'said once');
  });

  it('a failed turn clears the record: an older answer is never presented as the previous one', async () => {
    const memory = new AnswerDetailsMemory();
    let fail = false;
    const inputs: ChatTurnInput[] = [];
    const agent: ChatAgent = {
      chat: (input) => {
        inputs.push(input);
        return fail ? Promise.reject(new Error('boom')) : Promise.resolve({ text: 'a', speaker: mira, verifier: { status: 'verified' } });
      },
      async *chatStream(input): AsyncGenerator<ChatStreamEvent> {
        inputs.push(input);
        yield { type: 'text_delta', text: 'x' };
        throw new Error('stream broke');
      },
    };
    const recalled = recalling(agent, memory);
    await recalled.chat({ userMessage: '1', sessionScope: 's' });
    fail = true;
    await assert.rejects(recalled.chat({ userMessage: '2', sessionScope: 's' }));
    assert.equal(memory.get('s'), undefined);
    fail = false;
    await recalled.chat({ userMessage: '3', sessionScope: 's' });
    assert.ok(memory.get('s'));
    await assert.rejects(async () => {
      for await (const _ of recalled.chatStream({ userMessage: '4', sessionScope: 's' })) void _;
    });
    assert.equal(memory.get('s'), undefined);
  });

  it('a verifier correction retry keeps the record and adds the correction', () => {
    const retry = withCorrectionHint({ userMessage: 'x', extraSystemHint: 'RECORD' }, 'Correct claim 2.');
    assert.equal(retry.extraSystemHint, 'RECORD\n\nCorrect claim 2.');
    assert.equal(withCorrectionHint({ userMessage: 'x' }, 'C').extraSystemHint, 'C');
  });
});
