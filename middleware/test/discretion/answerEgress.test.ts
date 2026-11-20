/**
 * Spec 2042 §5.11 / §6 criteria 18 and 27 through a real turn:
 *
 *  - a group turn recalls a turn that kept the label of a narrower room
 *    (persisted transitively); the model paraphrases it; the answer is
 *    refused AS A WHOLE for the group — nothing of it reaches the people
 *    there, and the session log keeps only the line that replaced it;
 *  - the same recall where everyone present may know it answers normally;
 *  - the written turn keeps its label set (transitive persistence).
 *
 * Real `Orchestrator`, scripted model, fake retriever and stores.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { KnowledgeGraph } from '@omadia/plugin-api';

import type { ChatTurnInput } from '../../packages/harness-channel-sdk/src/chatAgent.js';
import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { Orchestrator, type OrchestratorOptions } from '../../packages/harness-orchestrator/src/orchestrator.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';
import { readersOf, unionLabels, type LabelSet } from '../../packages/harness-orchestrator/src/discretion/labels.js';
import type { DiscretionAuditEntry, DiscretionPort } from '../../packages/harness-orchestrator/src/discretion/port.js';
import { scriptedModel, text } from '../_helpers/replayTurnFixture.js';

const SECRET = 'Paula verlässt das Unternehmen zum Monatsende';

/** Canonical id = channel id: enough identity for the roster rule. */
const knowledgeGraph = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'resolveOrCreateChannelIdentity') {
        return async (input: { channelUserId: string }) => ({ omadiaUserId: input.channelUserId });
      }
      return undefined;
    },
  },
) as unknown as KnowledgeGraph;

function groupTurn(members: string[]): { input: ChatTurnInput; participants: () => Promise<unknown[]> } {
  const participants = Object.assign(
    async () => members.map((id) => ({ kind: 'user', channelUserId: id, displayName: id })),
    { completeRoster: true },
  );
  return {
    input: {
      userMessage: 'Was gibt es Neues im Team?',
      sessionScope: 'teams-group-1',
      userId: members[0],
      origin: {
        channelType: 'telegram',
        scope: { kind: 'conversation', conversationId: 'group-1' },
        conversationType: 'group',
        channelConversationId: 'group-1',
      },
    } as ChatTurnInput,
    participants,
  };
}

function build(recalledLabels: LabelSet) {
  const model = scriptedModel([text(`Kurz gesagt: ${SECRET}.`)]);
  const logged: Array<{ assistantAnswer: string }> = [];
  const persisted = new Map<string, LabelSet>();
  const audits: DiscretionAuditEntry[] = [];
  const discretion: DiscretionPort = {
    declarationOf: async () => undefined,
    labelsOf: async (_kind, ids) => new Map(ids.filter((id) => id === 'turn-old').map((id) => [id, recalledLabels])),
    persistLabels: async (_kind, id, _agent, labels) => {
      persisted.set(id, labels);
    },
    audit: (entry) => audits.push(entry),
  };
  const orchestrator = new Orchestrator({
    provider: model.provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 4,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    agentId: 'mira',
    knowledgeGraph,
    discretion,
    contextRetriever: {
      assembleForBudget: async () => ({
        text: `\n[früherer Turn] ${SECRET}`,
        included: [{ turnId: 'turn-old', score: 1, chars: 10, reason: 'fts', origin: 'fts' }],
        excluded: [],
        recalled: { plans: [], processes: [], insights: [] },
        stats: { candidatePool: 1, compactMode: false, tokensUsed: 10 },
      }),
    },
    sessionLogger: {
      log: async (entry: { assistantAnswer: string }) => {
        logged.push(entry);
        return { turnExternalId: 'turn-new' };
      },
    },
  } as unknown as OrchestratorOptions);
  return { orchestrator, model, logged, persisted, audits };
}

describe('the answer egress (criterion 18)', () => {
  it('an answer carrying a narrower room is refused as a whole and never stored', async () => {
    // The recalled turn was written where only a and b were present.
    const narrow = unionLabels([{ kind: 'context', key: 'telegram:dm-ab', readers: readersOf(['a', 'b']) }]);
    const { orchestrator, logged, persisted, audits } = build(narrow);
    const { input, participants } = groupTurn(['a', 'b', 'c']);
    const result = await turnContext.runWithChatParticipants(participants as never, () => orchestrator.chat(input));
    assert.equal(result.text.includes('Paula'), false, 'nothing of it reaches the group');
    assert.match(result.text, /nicht alle hier|not everyone here/);
    assert.equal(logged.length, 1);
    assert.equal(logged[0]!.assistantAnswer.includes('Paula'), false, 'the stored row keeps only the replacement');
    const refusal = audits.find((a) => a.egress === 'people' && !a.allowed);
    assert.ok(refusal, 'the refusal is audited');
    assert.ok(refusal.violations.includes('context:telegram:dm-ab:readers_not_covered'));
    assert.equal(JSON.stringify(audits).includes('Paula'), false, 'the audit never carries content');
    // Criterion 27 — the written turn kept the recalled label (transitively).
    const kept = persisted.get('turn-new');
    assert.ok(kept?.labels.some((l) => l.kind === 'context' && l.key === 'telegram:dm-ab'));
  });

  it('the same recall answers normally when everyone present may know it', async () => {
    const wide = unionLabels([{ kind: 'context', key: 'telegram:dm-ab', readers: readersOf(['a', 'b', 'c']) }]);
    const { orchestrator, logged } = build(wide);
    const { input, participants } = groupTurn(['a', 'b', 'c']);
    const result = await turnContext.runWithChatParticipants(participants as never, () => orchestrator.chat(input));
    assert.match(result.text, /Paula/);
    assert.match(logged[0]!.assistantAnswer, /Paula/);
  });
});
