/**
 * #1856 — every context heading the orchestrator's trust rules name is one the
 * chat path renders. The rules used to name `## Früher besprochene Entitäten`
 * and `## Inhaltlich ähnliche Turns`, while `assembleForBudget` puts hits from
 * other chats under `## Inhaltlich verwandte Turns`. Both sides now take the
 * headings from `RECALL_HEADINGS`.
 *
 * Drives the REAL `Orchestrator` with the REAL `ContextRetriever` over the
 * in-memory graph; only the model is scripted. All values are synthetic.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import type { LlmRequest } from '@omadia/llm-provider';

import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import {
  Orchestrator,
  type OrchestratorOptions,
} from '../packages/harness-orchestrator/src/orchestrator.js';
import {
  ContextRetriever,
  RECALL_HEADINGS,
  USER_CORRECTED_MARKER,
} from '@omadia/orchestrator-extras';
import { graphScopeFor } from '../packages/harness-orchestrator/src/sessionLogger.js';
import { scriptedModel, text } from './_helpers/replayTurnFixture.js';

const USER = 'user-1856';

/** The `system` argument of one provider request, its text blocks joined. */
function systemOf(request: LlmRequest | undefined): string {
  const system = (request as { system?: unknown } | undefined)?.system;
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .map((block: unknown) => (block as { text?: unknown }).text)
    .filter((t): t is string => typeof t === 'string')
    .join('\n');
}

/** The `## …` headings a system prompt names inside backticks. */
function namedHeadings(system: string): string[] {
  return [...system.matchAll(/`(## [^`]+)`/g)].map((m) => m[1]!);
}

describe('trust rules name the headings the chat path renders (#1856)', () => {
  it('a turn with tail and cross-chat recall', async () => {
    const graph = new InMemoryKnowledgeGraph();
    await graph.ingestTurn({
      scope: 'chat-earlier',
      time: '2026-11-20T09:00:00.000Z',
      userMessage: 'Projekt Falkenstein gehört zur Abteilung Vertrieb Nord.',
      assistantAnswer: 'Notiert.',
      entityRefs: [],
      userId: USER,
    });
    await graph.ingestTurn({
      // The tail is read under the agent-qualified scope the session logger writes.
      scope: graphScopeFor('default', 'chat-now'),
      time: '2026-11-21T09:00:00.000Z',
      userMessage: 'Guten Morgen.',
      assistantAnswer: 'Guten Morgen!',
      entityRefs: [],
      userId: USER,
    });
    const model = scriptedModel([text('Vertrieb Nord.')]);
    const orchestrator = new Orchestrator({
      provider: model.provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 2,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      contextRetriever: new ContextRetriever(graph),
    } as OrchestratorOptions);

    await orchestrator.chat({
      userMessage: 'Zu welcher Abteilung gehört Projekt Falkenstein?',
      sessionScope: 'chat-now',
      userId: USER,
    });

    const system = systemOf(model.requests[0]);
    // The block the chat path rendered carries both sections …
    assert.ok(system.includes(`\n${RECALL_HEADINGS.tail}`), 'tail section rendered');
    assert.ok(system.includes(`\n${RECALL_HEADINGS.relatedTurns}`), 'cross-chat section rendered');
    // … and every heading a rule names is one the retriever renders.
    const rendered = new Set<string>(Object.values(RECALL_HEADINGS));
    const named = namedHeadings(system);
    assert.ok(named.includes(RECALL_HEADINGS.relatedTurns), 'the trust rule names the cross-chat section');
    for (const heading of named) {
      assert.ok(rendered.has(heading), `rule names a heading nothing renders: ${heading}`);
    }
    // #1863 — the precedence rule for corrected entries quotes the marker the
    // retriever renders.
    assert.ok(system.includes(`„${USER_CORRECTED_MARKER} …“`), 'precedence rule for corrected entries');
    assert.equal(system.includes('Früher besprochene Entitäten'), false);
    assert.equal(system.includes('Inhaltlich ähnliche'), false);
  });
});
