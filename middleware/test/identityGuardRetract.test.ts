/**
 * Spec 2042 §5.11 — a streamed answer the discretion check withholds takes
 * back its preview (`text_retract` before the withheld `done`). The identity
 * guard sits outside the orchestrator and releases sentence by sentence; the
 * retract must also take back what it already released, and no sentence of
 * the draft may come out after it.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatAgent, ChatStreamEvent, SemanticAnswer } from '@omadia/channel-sdk';
import type { AgentSpeaker } from '@omadia/plugin-api';

import type { GuardDirectoryEntry } from '../packages/harness-orchestrator/src/identityGuard/deterministic.js';
import { IdentityGuard, type IdentityJudge } from '../packages/harness-orchestrator/src/identityGuard/guard.js';
import { withIdentityGuard } from '../packages/harness-orchestrator/src/identityGuard/guardedChatAgent.js';
import { AgentAnswerEmitter } from '../packages/harness-orchestrator/src/management/answerEmitter.js';

const mira: AgentSpeaker = { kind: 'agent', agentId: 'id-mira', slug: 'mira', displayName: 'Mira' };
const directory: GuardDirectoryEntry[] = [{ agentId: 'id-mira', slug: 'mira', displayName: 'Mira' }];
const WITHHELD = 'Das kann ich hier nicht beantworten, weil nicht alle hier es wissen dürfen.';

function guarded(events: readonly ChatStreamEvent[]): ChatAgent {
  const judge: IdentityJudge = { judge: () => Promise.resolve({ verdict: 'pass' }) };
  const emitter = new AgentAnswerEmitter({
    speaker: mira,
    guard: () => new IdentityGuard({ speaker: mira, directory, judge }),
    locale: () => 'de',
  });
  const inner: ChatAgent = {
    chat: (): Promise<SemanticAnswer> => Promise.reject(new Error('streamed only')),
    async *chatStream() {
      for (const event of events) yield event;
    },
  } as unknown as ChatAgent;
  return withIdentityGuard(inner, emitter);
}

/** What a client shows: the deltas, trimmed by every retract. */
function preview(events: readonly ChatStreamEvent[]): string {
  let shown = '';
  for (const e of events) {
    if (e.type === 'text_delta') shown += e.text;
    if (e.type === 'text_retract') shown = shown.slice(0, Math.max(0, shown.length - e.chars));
  }
  return shown;
}

describe('a withheld streamed answer behind the identity guard', () => {
  it('the retract takes back released and pending text alike', async () => {
    const released = 'Paula verlässt das Team. ';
    const pending = 'Sie geht zum Monatsende';
    const out: ChatStreamEvent[] = [];
    const agent = guarded([
      { type: 'text_delta', text: released },
      { type: 'text_delta', text: pending },
      { type: 'text_retract', chars: released.length + pending.length },
      { type: 'done', answer: WITHHELD, toolCalls: 0, iterations: 1 },
    ] as ChatStreamEvent[]);
    for await (const event of agent.chatStream({ userMessage: 'x', sessionScope: 's' } as never)) out.push(event);
    assert.ok(out.some((e) => e.type === 'text_delta' && e.text.includes('Paula')), 'the first sentence was released');
    assert.equal(preview(out), '', 'nothing of the draft stays');
    assert.equal(JSON.stringify(out).includes('Monatsende'), false, 'the pending sentence never comes out');
    const done = out.find((e) => e.type === 'done');
    assert.equal(done?.type === 'done' ? done.answer : undefined, WITHHELD);
  });
});
