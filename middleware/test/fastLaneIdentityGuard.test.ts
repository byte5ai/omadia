/**
 * #1876 / #2085 — spec 2042 §6 criterion 33 "fast lane under the guard":
 * a fast-lane planner summary claiming another agent's name is blocked by
 * the identity guard around the agent; the rows are side-channel data and
 * are never checked as the agent's words (a customer named like a colleague
 * does not block an invoice list). Boundaries on fast-lane plans, new and
 * cached, are criterion 35 (`dataPlanBoundaries.test.ts`).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatAgent, ChatStreamEvent, SemanticAnswer } from '@omadia/channel-sdk';
import type { AgentSpeaker, TableData } from '@omadia/plugin-api';

import { wrapChatAgentWithFastPath, type FastPathTriagePort } from '../packages/harness-orchestrator/src/fastPathAgent.js';
import type { GuardDirectoryEntry } from '../packages/harness-orchestrator/src/identityGuard/deterministic.js';
import { IdentityGuard } from '../packages/harness-orchestrator/src/identityGuard/guard.js';
import { withIdentityGuard } from '../packages/harness-orchestrator/src/identityGuard/guardedChatAgent.js';
import { AgentAnswerEmitter } from '../packages/harness-orchestrator/src/management/answerEmitter.js';

const lena: AgentSpeaker = { kind: 'agent', agentId: 'id-lena', slug: 'lena', displayName: 'Lena' };
const directory: GuardDirectoryEntry[] = [
  { agentId: 'id-lena', slug: 'lena', displayName: 'Lena' },
  { agentId: 'id-strategist', slug: 'strategist', displayName: 'Strategist' },
];

// The model layer blocks whatever it is shown: only text that reaches it
// (a colleague is mentioned) can be blocked by it.
const emitter = (): AgentAnswerEmitter =>
  new AgentAnswerEmitter({
    speaker: lena,
    guard: () => new IdentityGuard({ speaker: lena, directory, judge: { judge: () => Promise.resolve({ verdict: 'block' }) } }),
    locale: () => 'de',
  });

const inner: ChatAgent = {
  chat: () => Promise.reject(new Error('the agent loop must not run on a hit')),
  chatStream: () => {
    throw new Error('the agent loop must not run on a hit');
  },
};

function fastLane(summary: string, table: TableData): ChatAgent {
  const port: FastPathTriagePort = {
    channelEnabled: () => true,
    triageChatTurn: () => Promise.resolve({ kind: 'answer', text: summary, summary, table, tool: 'odoo_query', rows: table.rows.length, toolCalls: 1, ms: 1 }),
  };
  return withIdentityGuard(
    wrapChatAgentWithFastPath(inner, {
      fastPath: () => port,
      permittedTools: () => new Set(['odoo_query']),
      privacyGuarded: () => false,
      log: () => undefined,
    }),
    emitter(),
  );
}

const invoices: TableData = { kind: 'table', columns: ['Nummer', 'Kunde'], rows: [['RE-1', 'Strategist Consulting GmbH']] };

async function drain(agent: ChatAgent): Promise<Extract<ChatStreamEvent, { type: 'done' }>> {
  let done: Extract<ChatStreamEvent, { type: 'done' }> | undefined;
  for await (const ev of agent.chatStream({ userMessage: 'Offene Posten?', sessionScope: 'tab_1' })) if (ev.type === 'done') done = ev;
  assert.ok(done);
  return done;
}

describe('criterion 33 — the fast lane under the identity guard', () => {
  it('a planner summary claiming another agent is blocked, streamed and not', async () => {
    const agent = fastLane('Ich bin der Strategist und habe 1 offenen Posten gefunden.', invoices);
    const answer: SemanticAnswer = await agent.chat({ userMessage: 'Offene Posten?', sessionScope: 'tab_1' });
    assert.equal(answer.systemNotice?.code, 'identity_guard_blocked');
    assert.equal(answer.data, undefined, 'a withheld answer carries no rows');
    const done = await drain(agent);
    assert.equal(done.systemNotice?.code, 'identity_guard_blocked');
  });

  it('a customer named like a colleague in the rows does not block the answer', async () => {
    const agent = fastLane('1 offener Posten.', invoices);
    const answer = await agent.chat({ userMessage: 'Offene Posten?', sessionScope: 'tab_1' });
    assert.equal(answer.systemNotice, undefined);
    assert.deepEqual(answer.data, [invoices]);
    const done = await drain(agent);
    assert.equal(done.systemNotice, undefined);
    assert.ok(done.answer.includes('Strategist Consulting GmbH'));
  });
});
