/**
 * W0-3 — the tool block handed to the provider must serialize identically for
 * a given tool SET, regardless of the order the tools were registered in.
 *
 * `buildToolsList()` stamps `cache_control: { type: 'ephemeral' }` on the last
 * tool spec, which makes the whole block one Anthropic prompt-cache chunk. The
 * cache keys on a byte-exact prefix, so any reordering is a silent, total cache
 * miss for the tool block and everything after it. The dynamic segments are
 * iterated out of Maps — plugin load order for the native registry, `created_at`
 * row order for domain tools — so before the name sort, two Fly machines could
 * legitimately produce different byte streams for identical configuration.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import type { DomainTool } from '../../packages/harness-orchestrator/src/tools/domainQueryTool.js';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

const finalTextStream: LlmStreamEvent[] = [
  { type: 'text_delta', text: 'done' },
  {
    type: 'final',
    response: {
      content: [{ type: 'text', text: 'done' }],
      finishReason: 'stop',
      providerFinishReason: 'end_turn',
      model: 'test',
      usage: {
        inputTokens: 100,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  },
];

function recordingProvider(seenRequests: LlmRequest[]): LlmProvider {
  return {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (): Promise<LlmResponse> => {
      throw new Error('complete() not scripted');
    },
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      seenRequests.push(req);
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of finalTextStream) yield ev;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

const minimalSpec = (name: string): Record<string, unknown> => ({
  name,
  description: `${name} for testing`,
  input_schema: { type: 'object' as const, properties: {}, required: [] },
});

function domainTool(name: string): DomainTool {
  return {
    name,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spec: minimalSpec(name) as any,
    domain: `domain.${name}`,
    async handle() {
      return `${name}-output`;
    },
  } as DomainTool;
}

const NATIVE_NAMES = ['n_yankee', 'n_alpha', 'n_mike', 'n_bravo'] as const;
const DOMAIN_NAMES = ['d_zulu', 'd_charlie', 'd_papa', 'd_delta'] as const;

/**
 * Builds an orchestrator with the given registration orders, runs one turn,
 * and returns the request the provider actually saw.
 *
 * `buildToolsList()` output is not observable directly: `llmProviderSeam`
 * translates the Anthropic-shaped specs into the neutral `LlmRequest.tools`
 * (`input_schema` → `inputSchema`, `type` → `serverType`) and collapses the
 * per-tool `cache_control` into the request-level `cacheHints.tools` flag. The
 * Anthropic adapter then re-stamps `cache_control` on the LAST tool — which
 * `test/llmProviderAnthropicAdapter.test.ts` already covers. `LlmRequest.tools`
 * is therefore the ordered payload the wire tool block is built from, and the
 * right place to pin ordering.
 */
async function buildRequest(
  nativeOrder: readonly string[],
  domainOrder: readonly string[],
): Promise<LlmRequest> {
  const registry = new NativeToolRegistry();
  for (const name of nativeOrder) {
    registry.register(name, {
      handler: async () => `${name}-output`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec(name) as any,
      agentId: `plugin-${name}`,
    });
  }

  const seenRequests: LlmRequest[] = [];
  const orchestrator = new Orchestrator({
    provider: recordingProvider(seenRequests),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools: domainOrder.map(domainTool),
    nativeToolRegistry: registry,
  });

  for await (const _ev of orchestrator.chatStream({ userMessage: 'go' })) {
    // drain
  }

  const request = seenRequests[0];
  assert.ok(request, 'provider received no request');
  return request;
}

const toolNames = (request: LlmRequest): string[] =>
  (request.tools ?? []).map((tool) => tool.name);

/** A deterministic shuffle, so a failure is reproducible rather than flaky. */
function rotate<T>(items: readonly T[], by: number): T[] {
  const offset = ((by % items.length) + items.length) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

describe('W0-3 — deterministic tool ordering', () => {
  it('produces an identical name sequence for shuffled registration orders', async () => {
    const runA = await buildRequest(NATIVE_NAMES, DOMAIN_NAMES);
    const runB = await buildRequest(
      rotate(NATIVE_NAMES, 3),
      rotate(DOMAIN_NAMES, 2),
    );
    const runC = await buildRequest(
      [...NATIVE_NAMES].reverse(),
      [...DOMAIN_NAMES].reverse(),
    );

    assert.deepEqual(toolNames(runA), toolNames(runB));
    assert.deepEqual(toolNames(runA), toolNames(runC));

    // The dynamic segments are name-sorted; natives precede domain tools, and
    // the deliberate fixed-literal prefix (memory, …) keeps its own order.
    const names = toolNames(runA);
    assert.deepEqual(
      names.filter((n) => n.startsWith('n_')),
      ['n_alpha', 'n_bravo', 'n_mike', 'n_yankee'],
    );
    assert.deepEqual(
      names.filter((n) => n.startsWith('d_')),
      ['d_charlie', 'd_delta', 'd_papa', 'd_zulu'],
    );
    assert.ok(
      names.indexOf('n_yankee') < names.indexOf('d_charlie'),
      'native segment must stay ahead of the domain segment',
    );
  });

  it('keeps the fixed-literal prefix ahead of the sorted dynamic segments', async () => {
    const names = toolNames(await buildRequest(NATIVE_NAMES, DOMAIN_NAMES));

    // `memory` comes from the deliberate fixed prefix and sorts *after* every
    // `d_*`/`n_*` name alphabetically — so finding it first proves the prefix
    // was not swept into the sort.
    assert.equal(names[0], 'memory');
  });

  it('marks the tool block cacheable with a deterministic last element', async () => {
    const runA = await buildRequest(NATIVE_NAMES, DOMAIN_NAMES);
    const runB = await buildRequest(
      rotate(NATIVE_NAMES, 2),
      rotate(DOMAIN_NAMES, 1),
    );

    // `buildToolsList()` stamps `cache_control` on its last spec; the seam
    // collapses that to `cacheHints.tools`, and the Anthropic adapter re-stamps
    // the last tool (covered by test/llmProviderAnthropicAdapter.test.ts).
    assert.equal(runA.cacheHints?.tools, true);

    // Which tool receives the stamp must not depend on registration order —
    // that is exactly what used to drift between machines.
    const lastA = toolNames(runA).at(-1);
    assert.equal(lastA, toolNames(runB).at(-1));
    assert.equal(lastA, 'd_zulu');
  });

  it('golden-snapshots byte-identically across two orchestrator rebuilds', async () => {
    const first = await buildRequest(NATIVE_NAMES, DOMAIN_NAMES);
    const second = await buildRequest(
      rotate(NATIVE_NAMES, 1),
      rotate(DOMAIN_NAMES, 3),
    );

    // The whole point of the sort: the serialized tool block — the exact bytes
    // the prompt cache keys on — must match for the same tool set.
    assert.equal(
      JSON.stringify(first.tools),
      JSON.stringify(second.tools),
    );
  });
});
