/**
 * Spec 2042 follow-up — a withheld answer stays out of the agent's memory,
 * and the turn's record says what the identity guard decided.
 *
 * Live 2026-11-23: Dark Clippy's blocked draft ("if I introduced myself as …
 * that was wrong") was recorded as a turn, and every following "wer bist du"
 * turn recalled and repeated it. The orchestrator writes the record inside the
 * turn, before the guard (outermost) decides; the record gate settles the
 * verdict first.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatAgent, ChatStreamEvent, SemanticAnswer } from '@omadia/channel-sdk';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import type { AgentSpeaker, TurnAmend } from '@omadia/plugin-api';

import { withoutAnswer } from '../packages/harness-orchestrator/src/identityGuard/answerRecordGate.js';
import type { GuardDirectoryEntry } from '../packages/harness-orchestrator/src/identityGuard/deterministic.js';
import { IdentityGuard, type IdentityJudge } from '../packages/harness-orchestrator/src/identityGuard/guard.js';
import { withIdentityGuard } from '../packages/harness-orchestrator/src/identityGuard/guardedChatAgent.js';
import { AgentAnswerEmitter } from '../packages/harness-orchestrator/src/management/answerEmitter.js';
import type { SessionLogEntry, SessionLogger } from '../packages/harness-orchestrator/src/sessionLogger.js';
import { TurnRecordWriter } from '../packages/harness-orchestrator/src/turnRecordWriter.js';

const clippy: AgentSpeaker = { kind: 'agent', agentId: 'id-clippy', slug: 'clippy', displayName: 'Dark Clippy' };
const directory: GuardDirectoryEntry[] = [
  { agentId: 'id-clippy', slug: 'clippy', displayName: 'Dark Clippy' },
  { agentId: 'id-mira', slug: 'mira', displayName: 'Mira' },
];

interface Harness {
  readonly agent: ChatAgent;
  readonly rows: SessionLogEntry[];
  readonly judgeCalls: () => number;
}

/** An agent whose turn writes its record (as the orchestrator does) before
 *  its answer leaves, wrapped by the identity guard. */
function harness(answer: string, verdict: 'pass' | 'block' = 'pass', recordFirst = false): Harness {
  // `rows` holds each turn as the graph ends up with it: written, then
  // patched by the guard's verdict (`amendTurn`).
  const rows: SessionLogEntry[] = [];
  const logger = {
    log: (entry: SessionLogEntry) => {
      rows.push(entry);
      return Promise.resolve({ turnExternalId: `turn-${String(rows.length)}` });
    },
    amendTurn: (turnId: string, amend: TurnAmend) => {
      const i = Number(turnId.slice('turn-'.length)) - 1;
      const row = rows[i];
      if (row) {
        rows[i] = {
          ...row,
          ...(amend.identityGuard ? { identityGuard: amend.identityGuard } : {}),
          ...(amend.withholdAnswer ? { assistantAnswer: '' } : {}),
        };
      }
      return Promise.resolve();
    },
  } as unknown as SessionLogger;
  const writer = new TurnRecordWriter({ sessionLogger: logger, factExtractor: undefined });
  const record = (): Promise<string | undefined> =>
    writer.writeRow({ scope: 's', userMessage: 'wer bist du', assistantAnswer: answer, entityRefs: [] }, 'test');
  let calls = 0;
  const judge: IdentityJudge = {
    judge: () => {
      calls += 1;
      return Promise.resolve({ verdict });
    },
  };
  const emitter = new AgentAnswerEmitter({
    speaker: clippy,
    guard: () => new IdentityGuard({ speaker: clippy, directory, judge }),
    locale: () => 'de',
  });
  const inner: ChatAgent = {
    chat: async (): Promise<SemanticAnswer> => {
      const turnId = await record();
      return { text: answer, ...(turnId ? { turnId } : {}) } as SemanticAnswer;
    },
    chatStream: async function* (): AsyncGenerator<ChatStreamEvent> {
      // The verifier in `enforce` commits the record before it releases the
      // held answer as one delta (`verifierDelivery.ts`).
      const early = recordFirst ? await record() : undefined;
      if (recordFirst) yield { type: 'text_delta', text: answer };
      else for (const word of answer.split(/(?<= )/)) yield { type: 'text_delta', text: word };
      const turnId = early ?? (await record());
      yield { type: 'done', answer, toolCalls: 0, iterations: 1, ...(turnId ? { turnId } : {}) };
    },
  };
  return { agent: withIdentityGuard(inner, emitter), rows, judgeCalls: () => calls };
}

async function drain(stream: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const event of stream) out.push(event);
  await settled();
  return out;
}

/** The amend runs after the reply (it never delays it). */
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const BLOCKED = 'Ich bin Mira und kümmere mich um deine Rechnungen.';
const OWN = 'Ich bin Dark Clippy, ein KI-Agent und kein Mensch.';
/** Names a colleague: only the model layer can decide it. */
const JUDGED = 'Frag am besten Mira, sie kennt die Rechnungen.';

describe('identity guard — the turn record (streaming)', () => {
  it('a withheld answer is recorded without its text, with the verdict', async () => {
    const h = harness(BLOCKED);
    const events = await drain(h.agent.chatStream({ userMessage: 'wer bist du' } as never));
    const done = events.at(-1);
    assert.equal(done?.type, 'done');
    assert.ok(done?.type === 'done' && done.systemNotice, 'the user gets the notice');
    assert.equal(h.rows.length, 1);
    const row = h.rows[0];
    assert.equal(row?.assistantAnswer, '', 'the draft is no part of the agent memory');
    assert.equal(row?.userMessage, 'wer bist du');
    assert.equal(row?.identityGuard?.outcome, 'blocked');
    assert.equal(row?.identityGuard?.layer, 'deterministic');
    assert.equal(row?.identityGuard?.reason, 'other_agent_identity');
    assert.ok(!events.some((e) => e.type === 'text_delta' && e.text.includes('Mira')));
  });

  it('a released answer is recorded as said, with a pass verdict', async () => {
    const h = harness(OWN);
    const events = await drain(h.agent.chatStream({ userMessage: 'wer bist du' } as never));
    const text = events.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join('');
    assert.equal(text, OWN, 'the last sentence is still released before done');
    const row = h.rows[0];
    assert.equal(row?.assistantAnswer, OWN);
    assert.deepEqual(
      { outcome: row?.identityGuard?.outcome, layer: row?.identityGuard?.layer },
      { outcome: 'pass', layer: 'deterministic' },
    );
  });

  it('a colleague mention goes to the judge once; the record says layer model', async () => {
    const h = harness(JUDGED);
    await drain(h.agent.chatStream({ userMessage: 'wer kennt die Rechnungen?' } as never));
    assert.equal(h.rows[0]?.assistantAnswer, JUDGED);
    assert.equal(h.rows[0]?.identityGuard?.layer, 'model');
    assert.equal(h.judgeCalls(), 1);
  });

  it('a block by the judge records layer model and withholds the text', async () => {
    const h = harness(JUDGED, 'block');
    await drain(h.agent.chatStream({ userMessage: 'wer bist du' } as never));
    assert.equal(h.rows[0]?.assistantAnswer, '');
    assert.equal(h.rows[0]?.identityGuard?.outcome, 'blocked');
    assert.equal(h.rows[0]?.identityGuard?.layer, 'model');
  });
});

describe('identity guard — the record written before the text (verifier enforce)', () => {
  it('the row is still amended by the verdict that comes after it', async () => {
    const h = harness(JUDGED, 'block', true);
    await drain(h.agent.chatStream({ userMessage: 'wer bist du' } as never));
    assert.equal(h.rows.length, 1);
    assert.equal(h.rows[0]?.assistantAnswer, '');
    assert.equal(h.rows[0]?.identityGuard?.outcome, 'blocked');
  });
});

describe('identity guard — facts are learned only from a kept answer', () => {
  it('fact extraction waits for the verdict and is dropped for a withheld answer', async () => {
    for (const [answer, verdict, expected] of [
      [JUDGED, 'block', 0],
      [JUDGED, 'pass', 1],
    ] as const) {
      let extracted = 0;
      const logger = {
        log: () => Promise.resolve({ turnExternalId: 'turn-1' }),
        amendTurn: () => Promise.resolve(),
      } as unknown as SessionLogger;
      const writer = new TurnRecordWriter({
        sessionLogger: logger,
        factExtractor: {
          extractAndIngest: () => {
            extracted += 1;
            return Promise.resolve();
          },
        } as never,
      });
      const emitter = new AgentAnswerEmitter({
        speaker: clippy,
        guard: () =>
          new IdentityGuard({ speaker: clippy, directory, judge: { judge: () => Promise.resolve({ verdict }) } }),
        locale: () => 'de',
      });
      const inner: ChatAgent = {
        chat: async (): Promise<SemanticAnswer> => {
          const turnId = await writer.writeRow({ scope: 's', userMessage: 'q', assistantAnswer: answer, entityRefs: [] }, 't');
          writer.startFactExtraction(turnId, { userMessage: 'q', assistantAnswer: answer }, []);
          assert.equal(extracted, 0, 'nothing is learned before the guard decided');
          return { text: answer } as SemanticAnswer;
        },
        chatStream: () => {
          throw new Error('unused');
        },
      };
      await withIdentityGuard(inner, emitter).chat({ userMessage: 'q' } as never);
      await settled();
      assert.equal(extracted, expected, `${verdict}: facts ${expected === 0 ? 'dropped' : 'extracted'}`);
    }
  });
});

describe('identity guard — the turn record (chat)', () => {
  it('a withheld answer is recorded without its text; the answer is judged once', async () => {
    const h = harness(JUDGED, 'block');
    const answer = await h.agent.chat({ userMessage: 'wer bist du' } as never);
    await settled();
    assert.ok(answer.systemNotice, 'the user gets the notice');
    assert.equal(h.rows[0]?.assistantAnswer, '');
    assert.equal(h.rows[0]?.identityGuard?.outcome, 'blocked');
    assert.equal(h.judgeCalls(), 1, 'the answer is judged once');
  });

  it('a released answer keeps its text and a pass verdict', async () => {
    const h = harness(OWN);
    const answer = await h.agent.chat({ userMessage: 'wer bist du' } as never);
    await settled();
    assert.equal(answer.text, OWN);
    assert.equal(h.rows[0]?.assistantAnswer, OWN);
    assert.equal(h.rows[0]?.identityGuard?.outcome, 'pass');
  });
});

describe('a withheld row (identity guard, discretion)', () => {
  it('drops the answer and its masked twin, keeps the message and the notice for the mirror', () => {
    const row = withoutAnswer(
      {
        scope: 's',
        userMessage: 'Was verdient Mira?',
        assistantAnswer: 'Mira verdient …',
        maskedView: { userMessage: 'Was verdient «P1»?', assistantAnswer: '«P1» verdient …' },
      },
      'Dazu kann ich in dieser Runde nichts sagen.',
    );
    assert.equal(row.assistantAnswer, '');
    assert.equal(row.maskedView?.assistantAnswer, '');
    assert.equal(row.userMessage, 'Was verdient Mira?');
    assert.equal(row.transcriptAnswer, 'Dazu kann ich in dieser Runde nichts sagen.');
  });
});

describe('the verdict on the Turn node (KnowledgeGraph.amendTurn)', () => {
  const ingest = {
    scope: 's-guard',
    time: '2026-11-23T17:42:45.000Z',
    userMessage: 'wer bist du',
    assistantAnswer: 'Ich bin Mira.',
    entityRefs: [],
  };

  it('a kept answer gets the verdict, nothing else changes', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const { turnId } = await kg.ingestTurn(ingest);
    await kg.amendTurn(turnId, { identityGuard: { outcome: 'pass', layer: 'deterministic', latencyMs: 3 } });
    const props = (await kg.getSession('s-guard'))?.turns[0]?.turn.props;
    assert.deepEqual(props?.['identityGuard'], { outcome: 'pass', layer: 'deterministic', latencyMs: 3 });
    assert.equal(props?.['assistantAnswer'], 'Ich bin Mira.');
    assert.notEqual(props?.['tailOnly'], true);
  });

  it('a withheld answer loses its text and leaves recall', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const { turnId } = await kg.ingestTurn(ingest);
    await kg.amendTurn(turnId, {
      identityGuard: { outcome: 'blocked', layer: 'model', latencyMs: 812 },
      withholdAnswer: true,
    });
    const props = (await kg.getSession('s-guard'))?.turns[0]?.turn.props;
    assert.equal(props?.['assistantAnswer'], '');
    assert.equal(props?.['tailOnly'], true);
    assert.equal(props?.['userMessage'], 'wer bist du');
    assert.equal((props?.['identityGuard'] as { outcome?: string } | undefined)?.outcome, 'blocked');
  });
});
