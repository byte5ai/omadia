/**
 * Answer verbosity — the operator's target answer size as a prompt contract.
 *
 * Three properties carry the feature and are pinned here:
 *
 *  - **the delivered state is silent** — `standard` (and an unset or unknown
 *    field) emits no block, so an installation that never touched the setting
 *    gets a byte-identical system prompt and an unchanged prompt-cache key.
 *  - **a typo never picks a level** — the parser accepts only the five enum
 *    values (case- and whitespace-tolerant) and returns `undefined` otherwise.
 *  - **every other level names its contract** — the block says which setting
 *    produced it, tells the model to condense domain-agent results instead of
 *    re-telling them, and lets the user's own wording win for a turn.
 *
 * Orchestrator code is imported from SOURCE, not the built barrel, so a
 * mutation in `src/` cannot pass against a stale `dist/`.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import {
  ANSWER_VERBOSITY_LEVELS,
  DEFAULT_ANSWER_VERBOSITY,
  buildAnswerVerbosityBlock,
  parseAnswerVerbosity,
  type AnswerVerbosity,
} from '../packages/harness-orchestrator/src/answerVerbosity.js';
import {
  buildOrchestratorForAgent,
  type OrchestratorDeps,
} from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { loadManifestFromPath } from '../src/plugins/manifestLoader.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const usage = {
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
} as const;

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

/** Flatten `LlmRequest.system` (string or blocks) to one string. */
function systemText(req: LlmRequest): string {
  const sys = req.system;
  if (sys === undefined) return '';
  if (typeof sys === 'string') return sys;
  return sys
    .map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
    .join('\n');
}

/** A provider that answers with fixed text and records every system prompt. */
function capturingProvider(captured: string[]): LlmProvider {
  const response: LlmResponse = {
    content: [{ type: 'text', text: 'Antwort.' }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
  return {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      captured.push(systemText(req));
      return response;
    },
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => ({
      async *[Symbol.asyncIterator]() {
        captured.push(systemText(req));
        yield { type: 'text_delta', text: 'Antwort.' };
        yield { type: 'final', response };
      },
    }),
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

/**
 * Through the REAL wiring — `plugin.ts` hands the parsed field to
 * `OrchestratorDeps`, and `buildOrchestratorForAgent` is the single place a
 * production `Orchestrator` is constructed (main agent and registry agents
 * alike). A direct `new Orchestrator({ answerVerbosity })` would pass even if
 * the deps whitelist dropped the value, which is exactly the regression the
 * first draft of this feature had.
 */
async function systemPromptFor(
  answerVerbosity: AnswerVerbosity | undefined,
): Promise<string> {
  const captured: string[] = [];
  const deps: OrchestratorDeps = {
    provider: capturingProvider(captured),
    // Absent, not stubbed: the Orchestrator optional-chains these on a plain
    // text turn, while an empty `{}` would trip `entityRefBus.beginCollection`.
    knowledgeGraph: undefined as unknown as KnowledgeGraph,
    memoryStore: undefined as unknown as MemoryStore,
    entityRefBus: undefined as unknown as EntityRefBus,
    nativeToolRegistry: new NativeToolRegistry(),
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
    ...(answerVerbosity ? { answerVerbosity } : {}),
  };
  const built = buildOrchestratorForAgent(
    { agentId: 'solo', model: 'test', maxTokens: 1024, maxToolIterations: 3 },
    deps,
  );
  await built.orchestrator.chat({ userMessage: 'Wie viele offene Rechnungen gibt es?' });
  const first = captured[0];
  assert.ok(first !== undefined, 'provider never received a request');
  return first;
}

describe('parseAnswerVerbosity', () => {
  it('accepts every enum value, tolerant of case and whitespace', () => {
    for (const level of ANSWER_VERBOSITY_LEVELS) {
      assert.equal(parseAnswerVerbosity(level), level);
      assert.equal(parseAnswerVerbosity(`  ${level.toUpperCase()} `), level);
    }
  });

  it('returns undefined for unset, blank and unknown values', () => {
    assert.equal(parseAnswerVerbosity(undefined), undefined);
    assert.equal(parseAnswerVerbosity(null), undefined);
    assert.equal(parseAnswerVerbosity(''), undefined);
    assert.equal(parseAnswerVerbosity('   '), undefined);
    assert.equal(parseAnswerVerbosity('verbose'), undefined);
    assert.equal(parseAnswerVerbosity(3), undefined);
  });

  it('ships with standard as the default', () => {
    assert.equal(DEFAULT_ANSWER_VERBOSITY, 'standard');
  });
});

describe('buildAnswerVerbosityBlock', () => {
  it('emits nothing for standard — the delivered prompt stays byte-identical', () => {
    assert.equal(buildAnswerVerbosityBlock('standard'), '');
  });

  it('emits a named block for every other level', () => {
    for (const level of ANSWER_VERBOSITY_LEVELS) {
      if (level === 'standard') continue;
      const block = buildAnswerVerbosityBlock(level);
      assert.ok(block.startsWith('Antwortumfang ('), `${level}: heading`);
      assert.ok(block.endsWith('\n'), `${level}: trailing newline for splicing`);
      // Domain-agent results are raw material — the block must say so on
      // every level, otherwise the orchestrator re-tells them in full.
      assert.match(block, /Fach-Agenten sind Rohmaterial/, `${level}: condense rule`);
      // The operator's default never fights the person asking.
      assert.match(block, /gewinnt seine Bitte/, `${level}: user wording wins`);
    }
  });

  it('labels each level so a prompt reader sees the setting that produced it', () => {
    assert.match(buildAnswerVerbosityBlock('tldr'), /«TL;DR»/);
    assert.match(buildAnswerVerbosityBlock('brief'), /«Kurz»/);
    assert.match(buildAnswerVerbosityBlock('detailed'), /«Ausführlich»/);
    assert.match(buildAnswerVerbosityBlock('max'), /«Maximal»/);
  });

  it('short levels trim the DATASET, not just the prose around it', () => {
    // The privacy guard renders up to 50 rows server-side; a prose-only rule
    // would leave a 50-row table under a one-sentence answer.
    assert.match(buildAnswerVerbosityBlock('tldr'), /v4_top_n.*höchstens 5 Zeilen/);
    assert.match(buildAnswerVerbosityBlock('brief'), /v4_top_n.*höchstens 10 Zeilen/);
  });

  it('long levels ask for provenance and completeness', () => {
    assert.match(buildAnswerVerbosityBlock('detailed'), /welcher Fach-Agent/);
    assert.match(buildAnswerVerbosityBlock('max'), /Zwischenschritt/);
  });
});

describe('buildOrchestratorForAgent — answerVerbosity reaches the system prompt', () => {
  it('an unset option produces the same prompt as an explicit standard', async () => {
    const unset = await systemPromptFor(undefined);
    const standard = await systemPromptFor('standard');
    assert.equal(unset, standard);
    assert.doesNotMatch(unset, /Antwortumfang \(/);
  });

  it('tldr splices its block right after the language rule', async () => {
    const prompt = await systemPromptFor('tldr');
    const langIdx = prompt.indexOf('Sprache: Antworte immer auf Deutsch');
    const blockIdx = prompt.indexOf('Antwortumfang (vom Betreiber auf «TL;DR» gestellt)');
    assert.ok(langIdx >= 0, 'language rule missing');
    assert.ok(blockIdx > langIdx, 'verbosity block must follow the language rule');
    // Everything else is untouched: the block is an insertion, not a rewrite.
    const standard = await systemPromptFor('standard');
    assert.ok(prompt.length > standard.length);
    assert.ok(prompt.includes('Fach-Agenten (Routing-Regel'), 'routing block still present');
  });
});

// ── manifest — the operator's setup field ───────────────────────────────────

const MANIFEST = fileURLToPath(
  new URL('../packages/harness-orchestrator/manifest.yaml', import.meta.url),
);

describe('orchestrator manifest — answer_verbosity setup field', () => {
  it('is an enum whose values are exactly the code levels, defaulting to standard', async () => {
    const entry = await loadManifestFromPath(MANIFEST);
    assert.ok(entry, 'orchestrator manifest.yaml failed to load');
    const field = (entry.plugin.setup_fields ?? []).find(
      (f) => f.key === 'answer_verbosity',
    );
    assert.ok(field, 'missing setup field answer_verbosity');
    assert.equal(field.type, 'enum');
    assert.equal(field.default, DEFAULT_ANSWER_VERBOSITY);
    const values = (field.enum ?? []).map((e) =>
      typeof e === 'string' ? e : e.value,
    );
    assert.deepEqual(values, [...ANSWER_VERBOSITY_LEVELS]);
    for (const v of values) {
      assert.equal(parseAnswerVerbosity(v), v, `manifest value ${v} must parse`);
    }
  });
});
