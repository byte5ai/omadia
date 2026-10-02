/**
 * WP-10 — memory jobs OUTSIDE a turn: `PrivacyGuardService.openStoredTextScope`
 * and the extras' jobs wired through it.
 *
 * A job that runs outside a turn (the inconsistency detector, topic-cluster
 * naming, the Teams topic detector, and the recall judge or the session
 * briefing when no turn is active) opens one stored-text scope per run: the
 * identity shapes of the C0 baseline, the operator deny-list and C1 when
 * configured, whatever `mask_user_prompt` says, through the run's own
 * surrogate map so an output a user reads gets the real values back.
 * Failure-closed: `blocked`, or a privacy guard without the member, skips the
 * job's model call.
 *
 * Everything runs against the REAL privacy-guard service; values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { EmbeddingClient } from '@omadia/embeddings';
import type {
  ConversationTurn,
  GraphNode,
  KnowledgeGraph,
  PrivacyGuardService,
  PrivacyStoredTextScope,
  PromptPiiDetector,
  PromptPiiSpan,
} from '@omadia/plugin-api';
import {
  createHaikuSessionSummaryGenerator,
  createInconsistencyDetector,
  createRecallRelevanceJudge,
  createTopicClusteringService,
  TopicDetector,
} from '@omadia/orchestrator-extras';
import {
  createInTurnJobPrivacy,
  createJobPrivacy,
} from '@omadia/orchestrator-extras/dist/jobPrivacy.js';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import { createStoredTextScope } from '@omadia/plugin-privacy-guard/dist/storedTextScope.js';

const MAIL = 'jana.beispiel@firma.example';
const NAME = 'Jana Beispielfrau';
const SURROGATE_MAIL = /[\w.+-]+@example\.net/;
const STORED = `Rückruf bei ${NAME} (${MAIL}) wegen der Rechnung über 1.234,56 EUR vom 01.03.2026`;

interface RecordingLlm {
  readonly calls: unknown[];
  readonly llm: never;
}

/** Every string of the request's messages, i.e. the text the model reads. */
function userTextOf(request: unknown): string {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk((request as { messages?: unknown }).messages);
  return out.join('\n');
}

/** A provider that records every request and answers with `reply(requestText)`. */
function recordingLlm(reply: (requestText: string) => string): RecordingLlm {
  const calls: unknown[] = [];
  const llm = {
    async complete(request: unknown) {
      calls.push(request);
      return { content: [{ type: 'text', text: reply(userTextOf(request)) }] };
    },
  };
  return { calls, llm: llm as never };
}

/** The e-mail surrogate a masked request carried ('' when none). */
function surrogateIn(text: string): string {
  return SURROGATE_MAIL.exec(text)?.[0] ?? '';
}

function assertMaskedWire(call: unknown): void {
  const wire = JSON.stringify(call);
  assert.ok(!wire.includes(MAIL), wire);
  assert.ok(!wire.includes(NAME), wire);
  assert.match(wire, SURROGATE_MAIL);
}

/** Prompt masking left at its shipped default (off); NAME on the deny-list. */
function guardWithDenyList(): PrivacyGuardService {
  return createPrivacyGuardService({
    readConfig: (key) => (key === 'custom_terms' ? NAME : undefined),
  });
}

/** A guard whose stored-text scope blocks every text. */
function blockingGuard(): PrivacyGuardService {
  return {
    ...guardWithDenyList(),
    openStoredTextScope: (): PrivacyStoredTextScope => ({
      maskStoredText: async () => ({ outcome: 'blocked', reason: 'prompt PII detection failed' }),
      restoreStoredText: (text) => text,
    }),
  };
}

/** A privacy guard that predates the stored-text member. */
function olderGuard(): PrivacyGuardService {
  const older: PrivacyGuardService = { ...guardWithDenyList() };
  delete older.openStoredTextScope;
  return older;
}

/** A C1 stand-in that finds the given names, as the GLiNER sidecar would. */
function namesC1(...names: readonly string[]): PromptPiiDetector {
  return {
    id: 'c1-test',
    async detect(text: string): Promise<readonly PromptPiiSpan[]> {
      const spans: PromptPiiSpan[] = [];
      for (const name of names) {
        for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + name.length)) {
          spans.push({ start: at, end: at + name.length, type: 'person', confidence: 0.99 });
        }
      }
      return spans;
    },
  };
}

function mkNode(id: string, props: Record<string, unknown>): GraphNode {
  return { id, type: 'MemorableKnowledge', props } as unknown as GraphNode;
}

describe('privacy-guard — openStoredTextScope', () => {
  it('masks identity values with mask_user_prompt off and restores them in the output', async () => {
    const scope = guardWithDenyList().openStoredTextScope!({ job: 'test-job' });

    const result = await scope.maskStoredText(STORED);

    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.ok(!result.maskedText.includes(MAIL), result.maskedText);
    assert.ok(!result.maskedText.includes(NAME), result.maskedText);
    // Identity shapes only: amounts and dates stay readable.
    assert.ok(result.maskedText.includes('1.234,56 EUR'), result.maskedText);
    assert.ok(result.maskedText.includes('01.03.2026'), result.maskedText);
    assert.equal(result.degraded, false);
    assert.equal(scope.restoreStoredText(result.maskedText), STORED);
  });

  it('keeps surrogates stable within a run and separate between runs', async () => {
    const guard = guardWithDenyList();
    const run = guard.openStoredTextScope!({ job: 'run-a' });
    const first = await run.maskStoredText(`Mail an ${MAIL}`);
    const second = await run.maskStoredText(`Nochmal ${MAIL}`);
    assert.ok(first.outcome === 'masked' && second.outcome === 'masked');
    const surrogate = surrogateIn(first.maskedText);
    assert.notEqual(surrogate, '');
    assert.equal(surrogateIn(second.maskedText), surrogate);

    // Another run never restores this run's surrogates: its map is its own.
    const other = guard.openStoredTextScope!({ job: 'run-b' });
    assert.equal(other.restoreStoredText(surrogate), surrogate);
    assert.equal(run.restoreStoredText(surrogate), MAIL);
  });

  it('masks C1 names and degrades to the baseline for the rest of the run when C1 fails', async () => {
    const withC1 = createPrivacyGuardService({ c1Detector: namesC1('Max Mustermann') });
    const named = await withC1.openStoredTextScope!({ job: 'c1' }).maskStoredText(
      'Max Mustermann hat angerufen',
    );
    assert.ok(named.outcome === 'masked' && !named.maskedText.includes('Max Mustermann'));

    let c1Calls = 0;
    const failingC1: PromptPiiDetector = {
      id: 'c1-down',
      async detect(): Promise<readonly PromptPiiSpan[]> {
        c1Calls += 1;
        throw new Error('sidecar unreachable');
      },
    };
    const scope = createPrivacyGuardService({ c1Detector: failingC1 }).openStoredTextScope!({
      job: 'c1-down',
    });
    const first = await scope.maskStoredText(STORED);
    const second = await scope.maskStoredText(`Nochmal ${MAIL}`);
    assert.ok(first.outcome === 'masked' && first.degraded && !first.maskedText.includes(MAIL));
    assert.ok(second.outcome === 'masked' && second.degraded);
    assert.equal(c1Calls, 1, 'a failed C1 is not retried within the run');
  });

  it('blocks when detection fails — never a pass-through', async () => {
    const throwing: PromptPiiDetector = {
      id: 'c0-broken',
      async detect(): Promise<readonly PromptPiiSpan[]> {
        throw new Error('regex engine failure');
      },
    };
    const scope = createStoredTextScope({ job: 'broken', detectors: [throwing] });

    const result = await scope.maskStoredText(STORED);

    assert.equal(result.outcome, 'blocked');
  });
});

/** A knowledge graph holding two memories about the same contact. */
function inconsistencyKg(record: {
  readonly inconsistencies: Array<{ summary: string }>;
  readonly checked: string[];
}): KnowledgeGraph {
  const source = mkNode('mk-a', {
    summary: `Ansprechpartnerin ist ${NAME}`,
    rationale: `Rückfragen an ${MAIL}`,
    acl_owners: ['user-1'],
  });
  const other = mkNode('mk-b', {
    summary: 'Ansprechpartner ist jemand anderes',
    rationale: 'laut Telefonat',
    acl_owners: ['user-1'],
  });
  return {
    getMemorableKnowledge: async (id: string) => (id === 'mk-a' ? source : null),
    searchMemorableKnowledgeByEmbedding: async () => [
      { mk: source, cosineSim: 1 },
      { mk: other, cosineSim: 0.9 },
    ],
    createInconsistency: async (input: { summary: string }) => {
      record.inconsistencies.push(input);
      return true;
    },
    markMemorableKnowledgeInconsistencyChecked: async (id: string) => {
      record.checked.push(id);
    },
  } as unknown as KnowledgeGraph;
}

const embedder = { embed: async () => [1, 0, 0] } as unknown as EmbeddingClient;

describe('inconsistency detector — stored-text scope', () => {
  it('masks the stored memories and restores real values in the persisted summary', async () => {
    const record = { inconsistencies: [] as Array<{ summary: string }>, checked: [] as string[] };
    const provider = recordingLlm(
      (text) =>
        `{"compatible":"no","reason":"Kontakt ${surrogateIn(text)} widerspricht","severity":"high"}`,
    );
    const detector = createInconsistencyDetector({
      graph: inconsistencyKg(record),
      embeddingClient: embedder,
      llm: provider.llm,
      log: () => {},
      privacy: createJobPrivacy(() => guardWithDenyList()),
    });

    const result = await detector.detectFor('mk-a');

    assert.equal(provider.calls.length, 1);
    assertMaskedWire(provider.calls[0]);
    assert.equal(result.inconsistenciesCreated, 1);
    assert.equal(record.inconsistencies[0]?.summary, `Kontakt ${MAIL} widerspricht`);
    assert.deepEqual(record.checked, ['mk-a']);
  });

  it('skips the run without a provider call when the scope blocks, and leaves the memory unchecked', async () => {
    const record = { inconsistencies: [] as Array<{ summary: string }>, checked: [] as string[] };
    const provider = recordingLlm(() => '{"compatible":"no","reason":"x","severity":"high"}');
    const logs: string[] = [];
    const detector = createInconsistencyDetector({
      graph: inconsistencyKg(record),
      embeddingClient: embedder,
      llm: provider.llm,
      log: (msg) => {
        logs.push(msg);
      },
      privacy: createJobPrivacy(() => blockingGuard()),
    });

    await detector.detectFor('mk-a');

    assert.equal(provider.calls.length, 0);
    assert.deepEqual(record.inconsistencies, []);
    // Not marked: the next sweep retries once masking works again.
    assert.deepEqual(record.checked, []);
    assert.ok(logs.some((l) => l.includes('prompt PII detection failed')), JSON.stringify(logs));
  });
});

/** Three memories close enough to form one cluster. */
function clusteringKg(created: Array<{ name: string; description: string; namingSource: string }>) {
  const items = [1, 2, 3].map((i) => ({
    mk: mkNode(`mk-${String(i)}`, { summary: `Rückruf ${String(i)} bei ${NAME}, ${MAIL}` }),
    embedding: [1, 0, 0],
  }));
  return {
    listMemorableKnowledgeWithEmbeddings: async () => items,
    deleteAllTopics: async () => 0,
    createTopic: async (input: { name: string; description: string; namingSource: string }) => {
      created.push(input);
      return { id: `topic-${String(created.length)}` };
    },
  } as unknown as KnowledgeGraph;
}

describe('topic clustering — stored-text scope', () => {
  it('names a cluster from masked summaries and restores the real values in the name', async () => {
    const created: Array<{ name: string; description: string; namingSource: string }> = [];
    const provider = recordingLlm(
      (text) =>
        `{"name":"Kontakt ${surrogateIn(text)}","description":"Rückrufe an ${surrogateIn(text)}"}`,
    );
    const service = createTopicClusteringService({
      kg: clusteringKg(created),
      llm: provider.llm,
      log: () => {},
      privacy: createJobPrivacy(() => guardWithDenyList()),
    });

    await service.recluster();

    assert.equal(provider.calls.length, 1);
    assertMaskedWire(provider.calls[0]);
    assert.equal(created[0]?.name, `Kontakt ${MAIL}`);
    assert.equal(created[0]?.description, `Rückrufe an ${MAIL}`);
    assert.equal(created[0]?.namingSource, 'haiku');
  });

  it('falls back to a numbered name without a provider call when the scope blocks', async () => {
    const created: Array<{ name: string; description: string; namingSource: string }> = [];
    const provider = recordingLlm(() => '{"name":"x","description":"y"}');
    const service = createTopicClusteringService({
      kg: clusteringKg(created),
      llm: provider.llm,
      log: () => {},
      privacy: createJobPrivacy(() => blockingGuard()),
    });

    await service.recluster();

    assert.equal(provider.calls.length, 0);
    assert.equal(created[0]?.name, 'Cluster 1');
    assert.equal(created[0]?.namingSource, 'fallback');
  });

  it('skips the naming call when the installed guard predates the member', async () => {
    const created: Array<{ name: string; description: string; namingSource: string }> = [];
    const provider = recordingLlm(() => '{"name":"x","description":"y"}');
    const logs: string[] = [];
    const service = createTopicClusteringService({
      kg: clusteringKg(created),
      llm: provider.llm,
      log: (msg) => {
        logs.push(msg);
      },
      privacy: createJobPrivacy(() => olderGuard()),
    });

    await service.recluster();

    assert.equal(provider.calls.length, 0);
    assert.equal(created[0]?.namingSource, 'fallback');
    assert.ok(logs.some((l) => l.includes('cannot mask stored text')), JSON.stringify(logs));
  });
});

/** Embeddings that put every new message in the ambiguous band (cos ≈ 0.45),
 *  so the classifier decides. */
const ambiguousEmbeddings = {
  embed: async (text: string) => (text.startsWith('NEU') ? [1, 0, 0] : [1, 2, 0]),
} as unknown as EmbeddingClient;

const HISTORY: readonly ConversationTurn[] = [
  { userMessage: `Wer ist ${NAME}?`, assistantAnswer: `Sie ist erreichbar unter ${MAIL}.`, at: 1 },
];

describe('Teams topic detector — stored-text scope', () => {
  it('sends the previous exchange masked and honours the verdict', async () => {
    const provider = recordingLlm(() => 'continue');
    const detector = new TopicDetector(ambiguousEmbeddings, provider.llm, {
      privacy: createJobPrivacy(() => guardWithDenyList()),
    });

    const result = await detector.classify({ userMessage: 'NEU und ihre Telefonnummer?', history: HISTORY });

    assert.equal(provider.calls.length, 1);
    assertMaskedWire(provider.calls[0]);
    assert.equal(result.decision, 'continue');
  });

  it('asks the user without a provider call when the scope blocks', async () => {
    const provider = recordingLlm(() => 'continue');
    const detector = new TopicDetector(ambiguousEmbeddings, provider.llm, {
      privacy: createJobPrivacy(() => blockingGuard()),
    });

    const result = await detector.classify({ userMessage: 'NEU und ihre Telefonnummer?', history: HISTORY });

    assert.equal(provider.calls.length, 0);
    assert.equal(result.decision, 'ask');
  });
});

describe('the in-turn jobs outside a turn — stored-text scope', () => {
  const outsideAnyTurn = () => ({ current: () => undefined });

  it('the recall judge masks its request through a stored-text scope', async () => {
    const provider = recordingLlm(() => '{"relevant":["plan-1"]}');
    const judge = createRecallRelevanceJudge({
      llm: provider.llm,
      model: 'fast-model',
      log: () => {},
      privacy: createInTurnJobPrivacy({
        turnContext: outsideAnyTurn,
        outsideTurn: createJobPrivacy(() => guardWithDenyList()),
      }),
    });

    const kept = await judge.filterRelevant('Wann rufe ich zurück?', [
      { id: 'plan-1', kind: 'plan', text: STORED },
    ]);

    assert.deepEqual([...kept], ['plan-1']);
    assert.equal(provider.calls.length, 1);
    assertMaskedWire(provider.calls[0]);
  });

  it('the session briefing masks the transcript and restores real values in the summary', async () => {
    const provider = recordingLlm((text) => `- ${text}`);
    const generator = createHaikuSessionSummaryGenerator({
      llm: provider.llm,
      log: () => {},
      privacy: createInTurnJobPrivacy({
        turnContext: outsideAnyTurn,
        outsideTurn: createJobPrivacy(() => guardWithDenyList()),
      }),
    });

    const summary = await generator.generate({
      scope: 'chat-1',
      turns: [{ time: '2026-10-01T09:00:00.000Z', userMessage: STORED, assistantAnswer: 'Notiert.' }],
    });

    assert.equal(provider.calls.length, 1);
    assertMaskedWire(provider.calls[0]);
    assert.ok(summary.includes(MAIL), summary);
    assert.ok(summary.includes(NAME), summary);
  });
});
