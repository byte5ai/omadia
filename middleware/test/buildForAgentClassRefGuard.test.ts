/**
 * #1451 — a registry-built Agent must never run on a CLASS REF.
 *
 * `buildForAgent` resolved its three model tiers and then fell through to the
 * raw trimmed ref (`resolveConfiguredModel(ref) ?? ref.trim()`), with
 * `DEFAULT_ORCHESTRATOR_MODEL` (`class:frontier`) as the last resort. That is
 * correct for an id the curated registry simply does not list (a custom vendor
 * id, a bare CLI alias) and wrong for a class ref: when the active provider
 * serves no model at all — its catalog entry was unregistered because a
 * provider plugin that had shadowed a built-in id got uninstalled — every tier
 * yielded `undefined` and the Agent was published with `effectiveModel:
 * 'class:frontier'`, which 404s on the vendor API on every turn.
 *
 * Seam: `buildForAgent` → `BuiltOrchestrator.effectiveModel`, the id the turn
 * loop actually sends.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';
import { clearExternalModels, type LlmProvider } from '@omadia/llm-provider';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type { AgentRow } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { buildForAgent } from '../packages/harness-orchestrator/src/registry/applyDiff.js';
import { registerBuiltinProvidersIntoOverlay } from './_helpers/builtinProviders.js';

function fakeNativeToolRegistry(): NativeToolRegistry {
  const names = new Set<string>();
  return {
    has: (name: string) => names.has(name),
    register: (name: string) => {
      names.add(name);
      return () => names.delete(name);
    },
  } as unknown as NativeToolRegistry;
}

function deps(): OrchestratorDeps {
  return {
    provider: { id: 'anthropic' } as unknown as LlmProvider,
    knowledgeGraph: {} as KnowledgeGraph,
    memoryStore: {} as MemoryStore,
    entityRefBus: {} as EntityRefBus,
    nativeToolRegistry: fakeNativeToolRegistry(),
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
  };
}

function agentRow(slug: string): AgentRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    slug,
    name: slug,
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const runtime = { model: 'class:frontier', maxTokens: 100, maxToolIterations: 4 };

afterEach(() => clearExternalModels());

test('a class ref resolves to the provider concrete model when the catalog knows it', () => {
  registerBuiltinProvidersIntoOverlay();

  const built = buildForAgent(agentRow('accounting'), deps(), runtime);

  assert.ok(
    !built.effectiveModel.startsWith('class:'),
    `expected a concrete vendor id, got ${built.effectiveModel}`,
  );
});

test('a class ref no provider can serve fails the build instead of publishing class:*', () => {
  // The #1451 state: the provider has no models in the registry at all.
  clearExternalModels();

  assert.throws(
    () => buildForAgent(agentRow('accounting'), deps(), runtime),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /class:frontier/);
      assert.match(err.message, /anthropic/);
      // The platform tier failed, so the error names the platform setting.
      // The Agent itself is named by the caller's log line, which carries the
      // slug next to this message (`registry: diff action FAILED`).
      assert.match(err.message, /ORCHESTRATOR_MODEL/);
      return true;
    },
    'the Agent must not be published with a class ref as its model',
  );
});

test('the error names the per-Agent setting when that is the one that failed', () => {
  clearExternalModels();

  assert.throws(
    () =>
      buildForAgent(
        { ...agentRow('accounting'), modelRouting: { main: 'class:fast' } },
        deps(),
        runtime,
      ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /class:fast/);
      assert.match(err.message, /model_routing\.main of agent 'accounting'/);
      return true;
    },
  );
});

test('a registry-UNKNOWN concrete ref still passes through raw', () => {
  clearExternalModels();

  const built = buildForAgent(agentRow('cli-agent'), deps(), {
    ...runtime,
    model: 'some-operator-typed-model',
  });

  assert.equal(built.effectiveModel, 'some-operator-typed-model');
});
