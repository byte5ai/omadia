/**
 * Spec 2042 §5.11 / §5.12 (INV-9) through a real turn: a trigger firing's
 * turn has no origin, but it belongs to the conversation its trigger was
 * created in. Seeded with that conversation's key, readers and the creating
 * turn's labels:
 *
 *  - what was said in that room flows back to it (unseeded, the room is
 *    unknown and the same answer is refused);
 *  - what only a narrower room may know is still refused as a whole;
 *  - the creating turn's labels are the turn's from its start.
 *
 * Real `Orchestrator`, scripted model, fake retriever and stores.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { KnowledgeGraph } from '@omadia/plugin-api';

import type { ChatTurnInput } from '../../packages/harness-channel-sdk/src/chatAgent.js';
import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { Orchestrator, type OrchestratorOptions } from '../../packages/harness-orchestrator/src/orchestrator.js';
import { readersOf, unionLabels, type LabelSet } from '../../packages/harness-orchestrator/src/discretion/labels.js';
import { runWithSeededDiscretion } from '../../packages/harness-orchestrator/src/discretion/seededTurn.js';
import type { DiscretionPort } from '../../packages/harness-orchestrator/src/discretion/port.js';
import { scriptedModel, text } from '../_helpers/replayTurnFixture.js';

const NOTE = 'Das Angebot für ACME geht morgen raus';
const ROOM = 'telegram:group-1';
const roomLabel = { kind: 'context' as const, key: ROOM, readers: readersOf(['a', 'b', 'c']) };

const knowledgeGraph = new Proxy({}, { get: () => undefined }) as unknown as KnowledgeGraph;

function build(recalledLabels: LabelSet) {
  const model = scriptedModel([text(`Erinnerung: ${NOTE}.`)]);
  const persisted = new Map<string, LabelSet>();
  const discretion: DiscretionPort = {
    declarationOf: async () => undefined,
    labelsOf: async (_kind, ids) => new Map(ids.filter((id) => id === 'turn-old').map((id) => [id, recalledLabels])),
    persistLabels: async (_kind, id, _agent, labels) => {
      persisted.set(id, labels);
    },
    audit: () => undefined,
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
        text: `\n[früherer Turn] ${NOTE}`,
        included: [{ turnId: 'turn-old', score: 1, chars: 10, reason: 'fts', origin: 'fts' }],
        excluded: [],
        recalled: { plans: [], processes: [], insights: [] },
        stats: { candidatePool: 1, compactMode: false, tokensUsed: 10 },
      }),
    },
    sessionLogger: {
      log: async () => ({ turnExternalId: 'turn-new' }),
    },
  } as unknown as OrchestratorOptions);
  return { orchestrator, persisted };
}

/** A trigger firing's turn: no origin, no person. */
const firing: ChatTurnInput = { userMessage: 'Erinnere an das Angebot', sessionScope: 'trigger:t-1' } as ChatTurnInput;
const seeded = <T>(labels: LabelSet, work: () => Promise<T>, agentSlug = 'mira'): Promise<T> =>
  runWithSeededDiscretion({ agentSlug, contextKey: ROOM, readers: readersOf(['a', 'b', 'c']), labels }, work);

describe('a trigger firing is a labelled turn of its conversation (INV-9)', () => {
  it('what was said in the room flows back to it; unseeded the room is unknown and it is refused', async () => {
    const recalled = unionLabels([roomLabel]);
    const withSeed = build(recalled);
    const answer = await seeded(unionLabels([roomLabel]), () => withSeed.orchestrator.chat(firing));
    assert.match(answer.text, /ACME/);

    const withoutSeed = build(recalled);
    const refused = await withoutSeed.orchestrator.chat(firing);
    assert.equal(refused.text.includes('ACME'), false, 'an unknown room fails closed');
  });

  it('what only a narrower room may know is refused as a whole', async () => {
    const narrow = unionLabels([{ kind: 'context', key: 'telegram:dm-ab', readers: readersOf(['a', 'b']) }]);
    const { orchestrator } = build(narrow);
    const answer = await seeded(unionLabels([roomLabel]), () => orchestrator.chat(firing));
    assert.equal(answer.text.includes('ACME'), false);
    assert.match(answer.text, /nicht alle hier|not everyone here/);
  });

  it('the readers are the stored roster, not the narrower room label of older turns', async () => {
    // c joined later; an older turn of the room kept room:{a,b}.
    const olderRoomTurn = { ...roomLabel, readers: readersOf(['a', 'b']) };
    const narrow = unionLabels([{ kind: 'context', key: 'telegram:dm-ab', readers: readersOf(['a', 'b']) }]);
    const { orchestrator } = build(narrow);
    const answer = await seeded(unionLabels([roomLabel, olderRoomTurn]), () => orchestrator.chat(firing));
    assert.equal(answer.text.includes('ACME'), false, 'c may not know what only a and b may know');
  });

  it('a seed for another agent, or a turn with its own origin, is not seeded', async () => {
    const recalled = unionLabels([roomLabel]);
    const other = build(recalled);
    const refused = await seeded(unionLabels([roomLabel]), () => other.orchestrator.chat(firing), 'someone-else');
    assert.equal(refused.text.includes('ACME'), false, 'mira takes no seed meant for someone else');

    const withOrigin = build(recalled);
    const input = {
      ...firing,
      origin: { channelType: 'telegram', scope: { kind: 'conversation', conversationId: 'dm-x' }, conversationType: 'personal', channelConversationId: 'dm-x' },
    } as unknown as ChatTurnInput;
    const answer = await seeded(unionLabels([roomLabel]), () => withOrigin.orchestrator.chat(input));
    assert.equal(answer.text.includes('ACME'), false, 'a turn with an origin is its own room, not the seed');
  });

  it('the creating turn labels are the turn labels from its start', async () => {
    const source = { kind: 'source' as const, system: 'odoo', restricted: true };
    const { orchestrator, persisted } = build(unionLabels([roomLabel]));
    await seeded(unionLabels([roomLabel, source]), () => orchestrator.chat(firing));
    const kept = persisted.get('turn-new');
    assert.ok(kept?.labels.some((l) => l.kind === 'source' && l.system === 'odoo'), 'the creating turn read odoo');
    assert.ok(kept?.labels.some((l) => l.kind === 'context' && l.key === ROOM));
  });
});
