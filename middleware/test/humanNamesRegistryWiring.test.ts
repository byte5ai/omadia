/**
 * #2042 follow-up — the WIRING pin for `humanNames` on the registry path: the
 * plugin's per-turn lookup of the kernel's `humanNames@1` (`kernelHumanNames`,
 * plugin.ts) and its forward through `buildForAgent` (applyDiff.ts) into the
 * Orchestrator's per-turn `ownNames`. Dropping either must fail here.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import Anthropic from '@anthropic-ai/sdk';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import {
  HUMAN_NAMES_SERVICE,
  kernelHumanNames,
  type HumanNamesProvider,
} from '../packages/harness-orchestrator/src/plugin.js';
import { buildForAgent } from '../packages/harness-orchestrator/src/registry/applyDiff.js';
import type { AgentRow } from '../packages/harness-orchestrator/src/registry/configStore.js';

function deps(): OrchestratorDeps {
  const names = new Set<string>();
  return {
    client: new Anthropic({ apiKey: 'test-key' }),
    knowledgeGraph: {} as KnowledgeGraph,
    memoryStore: {} as MemoryStore,
    entityRefBus: {} as EntityRefBus,
    nativeToolRegistry: {
      has: (name: string) => names.has(name),
      register: (name: string) => {
        names.add(name);
        return () => names.delete(name);
      },
    } as unknown as NativeToolRegistry,
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
  } as unknown as OrchestratorDeps;
}

const KAREN: AgentRow = {
  id: '00000000-0000-0000-0000-00000000ca7e',
  slug: 'karen',
  name: 'Karen',
  description: null,
  privacyProfile: 'default',
  status: 'enabled',
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

/** A services stand-in publishing `humanNames@1` (or nothing). */
function services(provider?: HumanNamesProvider): { getOptional<T>(name: string): T | undefined } {
  return {
    getOptional<T>(name: string): T | undefined {
      assert.equal(name, HUMAN_NAMES_SERVICE);
      return provider as T | undefined;
    },
  };
}

/** The own names Karen's Orchestrator hands its privacy handle this turn. */
function ownNamesOfKaren(provider?: HumanNamesProvider): readonly string[] | undefined {
  const built = buildForAgent(KAREN, deps(), {
    model: 'claude-sonnet-4-5',
    maxTokens: 100,
    maxToolIterations: 4,
    humanNames: kernelHumanNames(services(provider)),
  });
  return (built.orchestrator as unknown as { ownNames?: () => readonly string[] }).ownNames?.();
}

describe('kernelHumanNames — the plugin\'s per-turn lookup', () => {
  it('yields null (unknown) while humanNames@1 is not published', () => {
    assert.equal(kernelHumanNames(services())(), null);
  });

  it('passes the published snapshot, and its null, through', () => {
    assert.deepEqual(kernelHumanNames(services(() => ['Karen']))(), ['Karen']);
    assert.equal(kernelHumanNames(services(() => null))(), null);
  });
});

describe('buildForAgent — humanNames reach the turn\'s own names', () => {
  it('exempts no own name when the service is missing', () => {
    assert.deepEqual(ownNamesOfKaren(), []);
  });

  it('exempts no own name while the directory is not loaded', () => {
    assert.deepEqual(ownNamesOfKaren(() => null), []);
  });

  it('drops a name an active user bears, keeps the rest', () => {
    assert.deepEqual(ownNamesOfKaren(() => ['Karen Müller', 'Karen', 'Müller']), []);
    assert.deepEqual(ownNamesOfKaren(() => ['Erika Muster', 'Erika', 'Muster']), ['Karen', 'karen']);
  });

  it('reads the service per turn, not once at build', () => {
    let names: readonly string[] | null = null;
    const built = buildForAgent(KAREN, deps(), {
      model: 'claude-sonnet-4-5',
      maxTokens: 100,
      maxToolIterations: 4,
      humanNames: kernelHumanNames(services(() => names)),
    });
    const ownNames = (built.orchestrator as unknown as { ownNames: () => readonly string[] }).ownNames;
    assert.deepEqual(ownNames(), []);
    names = [];
    assert.deepEqual(ownNames(), ['Karen', 'karen']);
  });
});
