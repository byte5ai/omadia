import type { LlmProvider, LlmProviderPool } from '@omadia/llm-provider';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import type { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';

/**
 * #1077 — the kernel services the orchestrator plugin's real `activate()`
 * needs before it builds `chatAgent@1`, with the subscription CLI as the
 * configured provider.
 *
 * The provider is only ever asked for its `id` at construction time: the
 * `claude-cli` branch of `buildOrchestratorForAgent` swaps in a
 * `CliChatAgent`, which spawns nothing until a turn runs. The stores are empty
 * objects for the same reason — `activate()` wires them, it does not call them.
 */
export const CLI_PROVIDER_ID = 'claude-cli';

export function fakeCliProviderPool(): LlmProviderPool {
  const provider = { id: CLI_PROVIDER_ID } as unknown as LlmProvider;
  return {
    get: async (id: string) => (id === CLI_PROVIDER_ID ? provider : undefined),
    usable: async (id: string) => id === CLI_PROVIDER_ID,
    invalidate: () => undefined,
    invalidateAll: () => undefined,
    cachedIds: () => [CLI_PROVIDER_ID],
  } as unknown as LlmProviderPool;
}

/** Minimal NativeToolRegistry — `activate()` and the Orchestrator constructor
 *  only call `has` and `register`. */
export function fakeNativeToolRegistry(): NativeToolRegistry {
  const names = new Set<string>();
  return {
    has: (name: string) => names.has(name),
    register: (name: string) => {
      names.add(name);
      return () => names.delete(name);
    },
  } as unknown as NativeToolRegistry;
}

/** The hard-required kernel services, plus the kernel provider pool. */
export function orchestratorKernelServices(): Record<string, unknown> {
  return {
    llmProviderPool: fakeCliProviderPool(),
    knowledgeGraph: {} as KnowledgeGraph,
    memoryStore: {} as MemoryStore,
    entityRefBus: {} as EntityRefBus,
    nativeToolRegistry: fakeNativeToolRegistry(),
  };
}

/** The setup fields that select the subscription CLI for the default Agent. */
export function cliOrchestratorConfig(
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    llm_provider: CLI_PROVIDER_ID,
    orchestrator_model: 'opus-cli',
    ...extra,
  };
}

/** Reads the private deps a `CliChatAgent` was constructed with. */
export function agentDeps(agent: unknown): Record<string, unknown> | undefined {
  return (agent as { deps?: Record<string, unknown> }).deps;
}
