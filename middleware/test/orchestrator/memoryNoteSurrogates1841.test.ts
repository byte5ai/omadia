/**
 * #1841 / ADR-0191 — with `mask_user_prompt` on, a `memory` note written
 * with one turn's placeholder read as a fact about another term in a later
 * turn: placeholders are only unique within a turn.
 *
 * The first block drives the REAL `Orchestrator` with the REAL privacy-guard
 * service over two turns; the second pins the fail-closed branches of
 * `memoryNoteSurrogates.ts` with a stub handle.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

import {
  MEMORY_NOTE_STALE_SURROGATE_NOTICE,
  MEMORY_NOTE_UNRESOLVED_NOTICE,
  maskMemoryNoteText,
  restoreMemoryNoteInput,
} from '../../packages/harness-orchestrator/src/memoryNoteSurrogates.js';
import type { PrivacyTurnHandle } from '../../packages/harness-orchestrator/src/privacyHandle.js';

const FALKENSTEIN = 'Projekt Falkenstein';
const ZEBRA = 'Projekt Zebra';
const PLACEHOLDER = /PLATZHALTER-CUSTOM-\d+/g;
const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } as const;

function maskingService(): ReturnType<typeof createPrivacyGuardService> {
  return createPrivacyGuardService({
    readConfig: (key: string) =>
      key === 'mask_user_prompt'
        ? 'on'
        : key === 'custom_terms'
          ? `${FALKENSTEIN}; ${ZEBRA}`
          : undefined,
  });
}

function reply(content: unknown[], finishReason: 'tool_calls' | 'stop'): LlmResponse {
  return {
    content,
    finishReason,
    providerFinishReason: finishReason === 'stop' ? 'end_turn' : 'tool_use',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

/** Step 1: one `memory` call built from the placeholder the model was sent;
 *  step 2: stop. Records every request. */
function memoryProvider(
  call: (placeholder: string) => Record<string, unknown>,
  requests: string[],
): LlmProvider {
  let step = 0;
  return {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      promptCaching: true,
      forcedToolChoice: true,
      parallelToolCalls: true,
    },
    complete: (req: LlmRequest) => {
      const serialized = JSON.stringify(req.messages);
      requests.push(serialized);
      step += 1;
      if (step === 1) {
        const placeholder = serialized.match(PLACEHOLDER)?.[0];
        assert.ok(placeholder, 'the model was sent a placeholder for the term');
        return Promise.resolve(
          reply([{ type: 'tool_call', id: 'use-1', name: 'memory', input: call(placeholder) }], 'tool_calls'),
        );
      }
      return Promise.resolve(reply([{ type: 'text', text: 'Fertig.' }], 'stop'));
    },
    stream: () => {
      throw new Error('not used');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

/** A `memory` tool over a plain map: `create` stores, `view` returns every file. */
function memoryRegistry(files: Map<string, string>, inputs: unknown[]): NativeToolRegistry {
  const registry = new NativeToolRegistry();
  registry.register('memory', {
    handler: (input: unknown) => {
      inputs.push(input);
      const { command, path, file_text: fileText } = input as Record<string, string>;
      if (command === 'create') {
        files.set(path!, fileText!);
        return Promise.resolve(`File created successfully at: ${path!}`);
      }
      return Promise.resolve([...files].map(([p, text]) => `${p}:\n${text}`).join('\n'));
    },
    spec: {
      name: 'memory',
      description: 'Memory',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    } as never,
  });
  return registry;
}

function orchestrator(provider: LlmProvider, registry: NativeToolRegistry): Orchestrator {
  const service = maskingService();
  return new Orchestrator({
    provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: registry,
    privacyGuard: () => service,
  } as ConstructorParameters<typeof Orchestrator>[0]);
}

/** The tool results the model was sent in a request. */
function toolResultsOf(request: string): string {
  return request.includes('tool_result') ? request.slice(request.indexOf('tool_result')) : '';
}

describe('#1841 — memory notes under prompt masking (real guard)', () => {
  it('stores the user value and reads it back under the reading turn\'s own placeholder', async () => {
    const files = new Map<string, string>();
    const inputs: unknown[] = [];
    const registry = memoryRegistry(files, inputs);

    // Turn 1 — the model notes a fact about the term it saw as a placeholder.
    const writeRequests: string[] = [];
    await orchestrator(
      memoryProvider(
        (ph) => ({
          command: 'create',
          path: `/memories/${ph.toLowerCase()}.md`,
          file_text: `# ${ph} - Gehört zur Abteilung Vertrieb Nord.`,
        }),
        writeRequests,
      ),
      registry,
    ).runTurn({ userMessage: `Notiere dir: ${FALKENSTEIN} gehört zur Abteilung Vertrieb Nord.` });

    assert.equal(files.size, 1);
    const [storedPath, storedText] = [...files][0] ?? [];
    assert.ok(storedText!.includes(FALKENSTEIN), 'the note holds the user value');
    assert.ok(!PLACEHOLDER.test(storedText!), 'no placeholder is persisted');
    PLACEHOLDER.lastIndex = 0;
    assert.ok(!/platzhalter/i.test(storedPath!), 'the file name holds no placeholder');
    for (const request of writeRequests) assert.ok(!request.includes('Falkenstein'));

    // Turn 2 — another term is the first one masked; the note must not read
    // as a fact about it.
    const readRequests: string[] = [];
    await orchestrator(
      memoryProvider(() => ({ command: 'view', path: '/memories' }), readRequests),
      registry,
    ).runTurn({ userMessage: `Zu welcher Abteilung gehört ${ZEBRA}? Schau in deine Notizen.` });

    const zebraPlaceholder = readRequests[0]!.match(PLACEHOLDER)?.[0];
    assert.ok(zebraPlaceholder);
    const result = toolResultsOf(readRequests[1]!);
    assert.ok(result.includes('Vertrieb Nord'), 'the note was read');
    assert.ok(!result.includes('Falkenstein') && !result.includes('Zebra'), 'no real value on the wire');
    const notePlaceholders = new Set(result.match(PLACEHOLDER) ?? []);
    assert.ok(notePlaceholders.size > 0, 'the note term is masked');
    assert.ok(!notePlaceholders.has(zebraPlaceholder), 'the note term is not read as the asked term');
  });

  it('reads a note about the asked term under that term\'s placeholder', async () => {
    const files = new Map([['/memories/note.md', `${FALKENSTEIN} gehört zur Abteilung Vertrieb Nord.`]]);
    const requests: string[] = [];
    await orchestrator(
      memoryProvider(() => ({ command: 'view', path: '/memories' }), requests),
      memoryRegistry(files, []),
    ).runTurn({ userMessage: `Zu welcher Abteilung gehört ${FALKENSTEIN}?` });

    const asked = requests[0]!.match(PLACEHOLDER)?.[0];
    assert.ok(asked);
    const result = toolResultsOf(requests[1]!);
    assert.ok(result.includes(`${asked} gehört zur Abteilung Vertrieb Nord`));
  });

  it('withholds an old note that carries a placeholder this turn minted for another value', async () => {
    const files = new Map([['/memories/old.md', 'PLATZHALTER-CUSTOM-1 gehört zur Abteilung Vertrieb Nord.']]);
    const requests: string[] = [];
    await orchestrator(
      memoryProvider(() => ({ command: 'view', path: '/memories' }), requests),
      memoryRegistry(files, []),
    ).runTurn({ userMessage: `Zu welcher Abteilung gehört ${ZEBRA}?` });

    const result = toolResultsOf(requests[1]!);
    assert.ok(!result.includes('Vertrieb Nord'), 'the stale note was not read as a fact');
    assert.ok(result.includes('withheld'));
  });
});

/** A stub handle with masking on over a one-entry map. */
function stubHandle(overrides: Partial<Record<string, unknown>> = {}): PrivacyTurnHandle {
  return {
    maskUserPrompt: async (text: string) => ({
      outcome: 'masked' as const,
      maskedText: text.split(FALKENSTEIN).join('PLATZHALTER-CUSTOM-2'),
      spans: [],
      degraded: false,
    }),
    restorePromptPseudonyms: async (text: string) => text.split('PLATZHALTER-CUSTOM-1').join(ZEBRA),
    countUnresolvedSurrogates: async (text: string) => (text.includes('PLATZHALTER-CUSTOM-1') ? 1 : 0),
    remaskPromptValues: (text: string) => text.split(ZEBRA).join('PLATZHALTER-CUSTOM-1'),
    ...overrides,
  } as unknown as PrivacyTurnHandle;
}

describe('#1841 — memoryNoteSurrogates fail closed (stub handle)', () => {
  it('restores every string of a write', async () => {
    const result = await restoreMemoryNoteInput(stubHandle(), {
      command: 'str_replace',
      old_str: 'PLATZHALTER-CUSTOM-1 alt',
      new_str: 'PLATZHALTER-CUSTOM-1 neu',
    });
    assert.deepEqual(result, {
      ok: true,
      input: { command: 'str_replace', old_str: `${ZEBRA} alt`, new_str: `${ZEBRA} neu` },
    });
  });

  it('refuses a write whose placeholder restore cannot map', async () => {
    const result = await restoreMemoryNoteInput(
      stubHandle({ restorePromptPseudonyms: async (text: string) => text }),
      { command: 'create', file_text: 'PLATZHALTER-CUSTOM-1' },
    );
    assert.deepEqual(result, { ok: false, notice: MEMORY_NOTE_UNRESOLVED_NOTICE });
  });

  it('refuses a write when restore throws', async () => {
    const result = await restoreMemoryNoteInput(
      stubHandle({
        restorePromptPseudonyms: async () => {
          throw new Error('boom');
        },
      }),
      { command: 'create', file_text: 'x' },
    );
    assert.equal(result.ok, false);
  });

  it('withholds a read when masking blocks', async () => {
    const result = await maskMemoryNoteText(
      stubHandle({
        maskUserPrompt: async (_text: string, opts?: { preview?: boolean }) =>
          opts?.preview === true
            ? { outcome: 'masked', maskedText: '', spans: [], degraded: false }
            : { outcome: 'blocked', reason: 'detector down' },
      }),
      `${FALKENSTEIN} gehört zu Vertrieb Nord.`,
    );
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes('Falkenstein'));
  });

  it('withholds a read that carries a placeholder of this turn', async () => {
    const result = await maskMemoryNoteText(stubHandle(), 'PLATZHALTER-CUSTOM-1 gehört zu Vertrieb Nord.');
    assert.deepEqual(result, { ok: false, notice: MEMORY_NOTE_STALE_SURROGATE_NOTICE });
  });

  it('leaves notes untouched with masking off (echo re-mask only)', async () => {
    const off = stubHandle({ maskUserPrompt: async () => ({ outcome: 'disabled' }) });
    assert.deepEqual(await restoreMemoryNoteInput(off, { file_text: 'PLATZHALTER-CUSTOM-1' }), {
      ok: true,
      input: { file_text: 'PLATZHALTER-CUSTOM-1' },
    });
    assert.deepEqual(await maskMemoryNoteText(off, `${ZEBRA} und ${FALKENSTEIN}`), {
      ok: true,
      text: `PLATZHALTER-CUSTOM-1 und ${FALKENSTEIN}`,
    });
  });
});
