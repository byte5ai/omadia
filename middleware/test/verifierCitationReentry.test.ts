/**
 * Production (v0.170.0, 2026-10-07): three Teams answers were withheld with
 * `citation_missing`, and each correction retry was abandoned: its
 * `query_knowledge_graph` call differed from the first run's, and the ledger
 * treated the graph tool as a WRITE (#1102 gave it a native handler, and
 * "has a handler ⇒ write" ran before the read-only branch). A re-entry may run
 * a kernel read it did not make in the first run; the graph tool is one.
 *
 * Pinned against a REAL `Orchestrator`, a real `VerifierPipeline` /
 * `VerifierService` and a real in-memory knowledge graph. Only the model is
 * scripted. Orchestrator, ledger and turn context come from SOURCE (one
 * AsyncLocalStorage — see `_helpers/replayTurnFixture.ts`).
 */

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

import type { ChatTurnInput } from '../packages/harness-channel-sdk/src/chatAgent.js';
import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { Orchestrator } from '../packages/harness-orchestrator/src/orchestrator.js';
import { ToolReplayLedger } from '../packages/harness-orchestrator/src/toolReplayLedger.js';
import { knowledgeGraphRefsOf } from '../packages/harness-orchestrator/src/runTraceCollector.js';
import { VerifierService } from '../packages/harness-orchestrator/src/verifierService.js';
import {
  VerifierPipeline,
  type ClaimExtraction,
  type ClaimExtractor,
  type DeterministicChecker,
  type EvidenceJudge,
} from '../packages/harness-verifier/src/index.js';
import { REQUEST, scriptedModel, text, toolCalls, toolResultContents } from './_helpers/replayTurnFixture.js';

async function seededGraph(): Promise<{ graph: InMemoryKnowledgeGraph; reads: string[] }> {
  const graph = new InMemoryKnowledgeGraph();
  await graph.ingestTurn({
    scope: 'talk-a',
    time: '2026-10-07T09:16:00.000Z',
    userMessage: 'Wer ist Anna?',
    assistantAnswer: 'Eine Mitarbeiterin.',
    entityRefs: [
      { system: 'odoo', model: 'hr.employee', id: 42, displayName: 'Anna Müller', op: 'read' },
    ],
  });
  const reads: string[] = [];
  const searchTurns = graph.searchTurns.bind(graph);
  graph.searchTurns = (opts) => {
    reads.push(opts.query);
    return searchTurns(opts);
  };
  return { graph, reads };
}

function orchestratorOver(graph: InMemoryKnowledgeGraph, responses: Parameters<typeof scriptedModel>[0]) {
  const model = scriptedModel(responses);
  const orchestrator = new Orchestrator({
    provider: model.provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    knowledgeGraph: graph,
  });
  return { orchestrator, model };
}

describe('a correction re-entry may read the knowledge graph again', () => {
  beforeEach(() => {
    mock.method(console, 'warn', () => undefined);
    mock.method(console, 'log', () => undefined);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it('runs a DIFFERENT query_knowledge_graph call on the re-entry instead of abandoning it', async () => {
    const { graph, reads } = await seededGraph();
    const { orchestrator, model } = orchestratorOver(graph, [
      toolCalls(['query_knowledge_graph', { query: 'search_turns', text: 'Anna' }]),
      text('Anna ist Mitarbeiterin.'),
      toolCalls(['query_knowledge_graph', { query: 'search_turns', text: 'Mitarbeiterin' }]),
      text('Anna ist Mitarbeiterin [ref:x].'),
    ]);
    const input: ChatTurnInput = { ...REQUEST };
    const ledger = new ToolReplayLedger();
    orchestrator.bindToolReplayLedger(input, ledger);

    await orchestrator.runTurn(input);
    ledger.beginReentry();
    const retry = await orchestrator.runTurn(input);

    assert.equal(ledger.abortedTool, undefined, 'the re-entry was not abandoned');
    assert.deepEqual(reads, ['Anna', 'Mitarbeiterin'], 'the new read ran on the re-entry');
    assert.match(retry.answer, /\[ref:x\]/, 'the retry answer is the one delivered');
    const retryResult = toolResultContents(model.requests[3]).join('\n');
    assert.doesNotMatch(retryResult, /was not run/, 'the model got a result, not a refusal');
  });

  it('answers an IDENTICAL query from the first run without asking the graph again', async () => {
    const { graph, reads } = await seededGraph();
    const call = ['query_knowledge_graph', { query: 'search_turns', text: 'Anna' }] as const;
    const { orchestrator } = orchestratorOver(graph, [
      toolCalls(call),
      text('Anna ist Mitarbeiterin.'),
      toolCalls(call),
      text('Anna ist Mitarbeiterin.'),
    ]);
    const input: ChatTurnInput = { ...REQUEST };
    const ledger = new ToolReplayLedger();
    orchestrator.bindToolReplayLedger(input, ledger);

    await orchestrator.runTurn(input);
    ledger.beginReentry();
    const retry = await orchestrator.runTurn(input);

    assert.deepEqual(reads, ['Anna'], 'the stored first-run result was replayed');
    // The replayed result still supplies the citable ids the verifier checks.
    const refs = knowledgeGraphRefsOf(retry.runTrace!) ?? [];
    assert.ok(refs.some((r) => r.startsWith('turn:')), JSON.stringify(refs));
  });

  it('records the turn ids a graph result showed the model, with their colons and dots', async () => {
    const { graph } = await seededGraph();
    const { orchestrator, model } = orchestratorOver(graph, [
      toolCalls(['query_knowledge_graph', { query: 'search_turns', text: 'Anna' }]),
      text('Anna ist Mitarbeiterin.'),
    ]);
    const result = await orchestrator.runTurn({ ...REQUEST });
    const refs = knowledgeGraphRefsOf(result.runTrace!) ?? [];
    assert.equal(refs.length, 1, JSON.stringify(refs));
    assert.match(refs[0]!, /^turn:talk-a:2026-10-07T09:16:00\.000Z$/);
    assert.ok(toolResultContents(model.requests[1]).join('\n').includes(refs[0]!), 'the model saw it');
  });

  it('records an empty list when the graph returned nothing citable', async () => {
    const { graph } = await seededGraph();
    const { orchestrator } = orchestratorOver(graph, [
      toolCalls(['query_knowledge_graph', { query: 'search_turns', text: 'nichts-dergleichen' }]),
      text('Dazu finde ich nichts.'),
    ]);
    const result = await orchestrator.runTurn({ ...REQUEST });
    assert.deepEqual(knowledgeGraphRefsOf(result.runTrace!), []);
  });

  it('leaves a turn without a graph call without the field', async () => {
    const { graph } = await seededGraph();
    const { orchestrator } = orchestratorOver(graph, [text('Hallo.')]);
    const result = await orchestrator.runTurn({ ...REQUEST });
    assert.equal(knowledgeGraphRefsOf(result.runTrace!), undefined);
  });
});

describe('end to end: a citation_missing withhold is corrected from the graph results', () => {
  beforeEach(() => {
    mock.method(console, 'warn', () => undefined);
    mock.method(console, 'log', () => undefined);
    mock.method(console, 'error', () => undefined);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  const TURN = 'turn:talk-a:2026-10-07T09:16:00.000Z';

  /** The REAL pipeline; only the claim extraction and checkers are stubbed
   *  (the answers carry no trigger signal, so they never run). */
  function realPipeline(): VerifierPipeline {
    return new VerifierPipeline({
      extractor: {
        extract: (): Promise<ClaimExtraction> => Promise.resolve({ claims: [], gaps: [] }),
      } as unknown as ClaimExtractor,
      deterministic: { checkAll: () => Promise.resolve([]) } as unknown as DeterministicChecker,
      judge: { checkAll: () => Promise.resolve([]) } as unknown as EvidenceJudge,
      log: () => undefined,
    });
  }

  async function enforced(retryAnswer: string) {
    const { graph, reads } = await seededGraph();
    const { orchestrator, model } = orchestratorOver(graph, [
      toolCalls(['query_knowledge_graph', { query: 'search_turns', text: 'Anna' }]),
      text('Anna ist Mitarbeiterin.'),
      // The retry asks differently — the production case that was abandoned.
      toolCalls(['query_knowledge_graph', { query: 'search_turns', text: 'Mitarbeiterin' }]),
      text(retryAnswer),
    ]);
    const logs: string[] = [];
    const service = new VerifierService({
      orchestrator,
      // Source pipeline into the source service; the option is typed against
      // the package's built declarations.
      pipeline: realPipeline() as unknown as ConstructorParameters<typeof VerifierService>[0]['pipeline'],
      enabled: true,
      mode: 'enforce',
      maxRetries: 1,
      log: (line: string) => {
        logs.push(line);
      },
    });
    const answer = await service.chat({ ...REQUEST });
    return { answer, logs, reads, model };
  }

  it('retries with a new graph query and delivers the cited answer, markers stripped', async () => {
    const { answer, logs, reads, model } = await enforced(`Anna ist Mitarbeiterin [ref:${TURN}].`);
    assert.equal(answer.answerSource, undefined, `delivered, not withheld — ${logs.join(' | ')}`);
    assert.ok(answer.text.startsWith('Anna ist Mitarbeiterin.'), answer.text);
    assert.doesNotMatch(answer.text, /\[ref:/, 'no marker reaches the user');
    assert.deepEqual(reads, ['Anna', 'Mitarbeiterin']);
    assert.ok(!logs.some((l) => /abandoned/.test(l)), logs.join('\n'));
    // The retry was told to cite the id fields, not that a source contradicted it.
    const hint = JSON.stringify(model.requests[2]?.system ?? '');
    assert.match(hint, /Verifier hat die Antwort zurückgehalten/);
  });

  it('withholds an invented source as unbacked — never as a contradiction', async () => {
    const { answer, logs } = await enforced('Anna ist Mitarbeiterin [ref:turn:talk-a:erfunden].');
    assert.equal(answer.answerSource, 'verifier-blocked');
    assert.match(answer.text, /ließen sich mit den abgerufenen Daten belegen/i);
    assert.doesNotMatch(answer.text, /Widerspruch/);
    assert.ok(logs.some((l) => /cause=insufficient_evidence/.test(l)), logs.join('\n'));
  });

  it('keeps the citable ids off the delivered trace payload', async () => {
    const { graph } = await seededGraph();
    const { orchestrator } = orchestratorOver(graph, [
      toolCalls(['query_knowledge_graph', { query: 'search_turns', text: 'Anna' }]),
      text(`Anna ist Mitarbeiterin [ref:${TURN}].`),
    ]);
    const result = await orchestrator.runTurn({ ...REQUEST });
    assert.deepEqual(knowledgeGraphRefsOf(result.runTrace!), [TURN]);
    assert.doesNotMatch(JSON.stringify(result.runTrace), /knowledgeGraphRefs|turn:talk-a/);
  });
});
