import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type { AgentRow } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { buildForAgent } from '../packages/harness-orchestrator/src/registry/applyDiff.js';
import {
  DEFAULT_AGENT_IDENTITY,
  identityRules,
} from '../packages/harness-orchestrator/src/management/agentIdentityPrompt.js';

/**
 * #2056 — the compiled system prompt starts from the agent's own identity
 * (spec 2042 G1, §5.5): no prompt carries the old delegating identity, every
 * agent's identity carries the rules that it speaks only as itself, and one
 * prompt snapshot per archetype pins the composed identity.
 *
 * Snapshots live in `test/fixtures/agentPrompt/<archetype>.txt`; run with
 * `UPDATE_PROMPT_SNAPSHOTS=1` to rewrite them after a deliberate change.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'agentPrompt');
const DELEGATING = /delegier|delegating to special/i;

function deps(assistantIdentity?: string): OrchestratorDeps {
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
    ...(assistantIdentity ? { assistantIdentity } : {}),
  } as unknown as OrchestratorDeps;
}

function agentRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    slug: 'mira',
    name: 'Mira',
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    identityName: 'Mira',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function identityOf(built: ReturnType<typeof buildForAgent>): string {
  return String((built.orchestrator as unknown as { assistantIdentity?: unknown }).assistantIdentity);
}

function matchesSnapshot(name: string, actual: string): void {
  const file = path.join(FIXTURES, `${name}.txt`);
  if (process.env['UPDATE_PROMPT_SNAPSHOTS'] === '1') writeFileSync(file, actual);
  assert.equal(actual, readFileSync(file, 'utf8'), `prompt snapshot ${name} changed`);
}

const runtime = { model: 'claude-sonnet-4-6', maxTokens: 1024, maxToolIterations: 4 };

describe('agent identity prompt', () => {
  it('the default identity describes a colleague, not a delegating assistant', () => {
    assert.doesNotMatch(DEFAULT_AGENT_IDENTITY, DELEGATING);
    assert.match(identityRules(), /nur als du selbst/);
    assert.match(identityRules(), /nie als Mensch/);
  });

  it('names the colleagues the agent may consult', () => {
    assert.match(identityRules(['Strategist', 'Hanna']), /Strategist, Hanna/);
    assert.match(identityRules([]), /nicht eingerichtet/);
  });

  it('an agent without authored identity starts from the default identity and carries the rules', () => {
    const identity = identityOf(buildForAgent(agentRow(), deps(), runtime));
    assert.ok(identity.startsWith(DEFAULT_AGENT_IDENTITY));
    assert.match(identity, /Dein Name ist Mira/);
    assert.match(identity, /## Wer du bist/);
    assert.doesNotMatch(identity, DELEGATING);
  });

  it('an authored identity is kept and still carries the rules', () => {
    const identity = identityOf(
      buildForAgent(agentRow({ instructions: 'Du betreust den Vertrieb.' }), deps(), runtime),
    );
    assert.ok(identity.startsWith('Du betreust den Vertrieb.'));
    assert.match(identity, /## Wer du bist/);
  });

  for (const archetype of ['standard', 'facilitator'] as const) {
    it(`prompt snapshot: archetype ${archetype}`, () => {
      const identity = identityOf(buildForAgent(agentRow({ archetype }), deps(), runtime));
      assert.doesNotMatch(identity, DELEGATING);
      matchesSnapshot(archetype, identity);
    });
  }
});
