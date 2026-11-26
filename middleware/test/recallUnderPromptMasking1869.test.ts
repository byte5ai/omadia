/**
 * #1869 — with prompt masking on, recall still finds earlier turns about a
 * masked value, and the model still sees only the surrogate.
 *
 * Stored turns hold real values (the wire mask is never persisted). The
 * orchestrator used to hand the retriever the pseudonymised message, so term
 * extraction, the query embedding and the full-text query searched for the
 * surrogate and missed every turn about the masked value. Now every search leg
 * runs on the real message; only the relevance judge (a model call) reads the
 * wire variant, and the recalled block is masked through the turn's map before
 * it reaches the model.
 *
 * Drives the REAL `Orchestrator` and the REAL `ContextRetriever` over the
 * in-memory graph; only the model and the privacy service are scripted. All
 * values are synthetic.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import type { LlmRequest } from '@omadia/llm-provider';

import type { ChatTurnInput } from '../packages/harness-channel-sdk/src/chatAgent.js';
import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import {
  Orchestrator,
  type OrchestratorOptions,
} from '../packages/harness-orchestrator/src/orchestrator.js';
import {
  ContextRetriever,
  type AssembleForBudgetInput,
} from '@omadia/orchestrator-extras';
import { promptMaskingPrivacy, surrogate } from './_helpers/promptMaskingPrivacy.js';
import { scriptedModel, text } from './_helpers/replayTurnFixture.js';

const ADDRESS = 'falkenstein@kunde.example';
const USER = 'user-1869';
const FACT = `Notiere dir: ${ADDRESS} gehört zur Abteilung Vertrieb Nord.`;

/** The `system` argument of one provider request, as text. */
function systemOf(request: LlmRequest | undefined): string {
  const system = (request as { system?: unknown } | undefined)?.system;
  return typeof system === 'string' ? system : JSON.stringify(system ?? '');
}

async function setup() {
  const graph = new InMemoryKnowledgeGraph();
  // An earlier chat of the same user, stored with the real value.
  await graph.ingestTurn({
    scope: 'chat-earlier',
    time: '2026-11-20T09:00:00.000Z',
    userMessage: FACT,
    assistantAnswer: 'Notiert.',
    entityRefs: [],
    userId: USER,
  });
  const retriever = new ContextRetriever(graph);
  const seen: AssembleForBudgetInput[] = [];
  const assemble = retriever.assembleForBudget.bind(retriever);
  retriever.assembleForBudget = (input) => {
    seen.push(input);
    return assemble(input);
  };
  const privacy = promptMaskingPrivacy();
  const model = scriptedModel([text(`${surrogate(1)} gehört zu Vertrieb Nord.`)]);
  const orchestrator = new Orchestrator({
    provider: model.provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 2,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    contextRetriever: retriever,
    privacyGuard: () => privacy.service,
  } as OrchestratorOptions);
  return { orchestrator, model, seen };
}

describe('recall under prompt masking (#1869)', () => {
  it('searches with the real message and puts only the surrogate on the wire', async () => {
    const { orchestrator, model, seen } = await setup();
    const input: ChatTurnInput = {
      userMessage: `Was weißt du über ${ADDRESS} aus früheren Gesprächen?`,
      sessionScope: 'chat-now',
      userId: USER,
    };

    const result = await orchestrator.chat(input);

    assert.equal(seen.length, 1, 'the turn recalled once');
    assert.equal(seen[0]!.userMessage, input.userMessage, 'the search legs read the real message');
    assert.equal(seen[0]!.judgeMessage?.includes(ADDRESS), false, 'the judge reads the wire variant');
    assert.ok(seen[0]!.judgeMessage?.includes(surrogate(1)));

    const system = systemOf(model.requests[0]);
    assert.ok(system.includes('Vertrieb Nord'), 'the earlier turn about the masked value was recalled');
    assert.equal(system.includes(ADDRESS), false, 'the recalled block carries the real value');
    assert.ok(system.includes(surrogate(1)), 'the recalled block carries the surrogate');
    assert.ok(result.text.includes(ADDRESS), 'the delivered answer is restored');
  });
});
