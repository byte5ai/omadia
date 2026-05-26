/**
 * US8 / T036 — per-Agent memory scoping acceptance tests.
 *
 *  1. SC-003 — a Public Agent (with Confluence but not Odoo-HR plugin) can
 *     read Confluence memory and cannot read Odoo-HR memory.
 *  2. Two Agents that share a plugin both see that plugin's memory.
 *  3. Removing a plugin from an Agent makes its memory entry invisible to
 *     that Agent while the underlying file persists (soft-deny read; the
 *     file reappears when the plugin is re-enabled).
 *  4. T033 — `computeMemoryScope` is the union of enabled-plugin scopes
 *     plus the constant `core` namespace.
 *  5. T035 — the session `ConfigSnapshot.memoryScope` matches the Agent's
 *     computed scope at capture time.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';
import { FilesystemMemoryStore } from '@omadia/memory';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph } from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import { ChatSessionStore } from '../packages/harness-orchestrator/src/chatSessionStore.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type {
  AgentPluginRow,
  AgentRow,
  ConfigSnapshot,
  ConfigStore,
} from '../packages/harness-orchestrator/src/registry/configStore.js';
import {
  computeMemoryScope,
  OrchestratorRegistry,
  type PluginCapabilityLookup,
} from '../packages/harness-orchestrator/src/registry/index.js';
import {
  MemoryScopeViolation,
  ScopedMemoryStore,
} from '../packages/harness-orchestrator/src/registry/scopedMemoryStore.js';

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

function deps(memoryStore: FilesystemMemoryStore): OrchestratorDeps {
  return {
    client: new Anthropic({ apiKey: 'test-key' }),
    knowledgeGraph: {} as KnowledgeGraph,
    memoryStore,
    entityRefBus: {} as EntityRefBus,
    nativeToolRegistry: fakeNativeToolRegistry(),
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
  };
}

function agent(slug: string, id: string, overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id,
    slug,
    name: slug,
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function plugin(agentId: string, pluginId: string, enabled = true): AgentPluginRow {
  return {
    agentId,
    pluginId,
    config: {},
    enabled,
    createdAt: new Date(0),
  };
}

const PLUGIN_SCOPES: Record<string, readonly string[]> = {
  '@omadia/agent-confluence': ['agent:@omadia/agent-confluence:*'],
  '@omadia/agent-odoo-hr': ['agent:@omadia/agent-odoo-hr:*'],
  '@omadia/agent-shared': ['agent:@omadia/agent-shared:*'],
};

const lookup: PluginCapabilityLookup = {
  isMultiInstance: () => true,
  getMemoryScope: (id) => PLUGIN_SCOPES[id],
};

test('T033: computeMemoryScope unions enabled plugin scopes + core', () => {
  const scope = computeMemoryScope(
    [
      plugin('a-id', '@omadia/agent-confluence'),
      plugin('a-id', '@omadia/agent-odoo-hr', /* enabled */ false),
      plugin('a-id', '@omadia/agent-shared'),
    ],
    lookup,
  );
  assert.deepEqual([...scope].sort(), [
    'agent:@omadia/agent-confluence:*',
    'agent:@omadia/agent-shared:*',
    'core',
  ]);
});

test('T033: computeMemoryScope without a lookup degrades to [core]', () => {
  const scope = computeMemoryScope(
    [plugin('a-id', '@omadia/agent-confluence')],
    undefined,
  );
  assert.deepEqual([...scope], ['core']);
});

test('SC-003: a Public Agent reads Confluence memory but NOT Odoo-HR memory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omadia-mem-'));
  const inner = new FilesystemMemoryStore(dir);
  // Seed memory for both plugins.
  await inner.writeFile(
    '/memories/agents/@omadia/agent-confluence/notes.md',
    'confluence',
  );
  await inner.writeFile(
    '/memories/agents/@omadia/agent-odoo-hr/notes.md',
    'odoo-hr',
  );

  const scoped = new ScopedMemoryStore({
    agentSlug: 'public',
    scope: ['agent:@omadia/agent-confluence:*', 'core'],
    inner,
  });

  assert.equal(
    await scoped.readFile('/memories/agents/@omadia/agent-confluence/notes.md'),
    'confluence',
  );

  assert.equal(
    await scoped.fileExists('/memories/agents/@omadia/agent-odoo-hr/notes.md'),
    false,
    'Odoo-HR file invisible to the Public Agent',
  );
  await assert.rejects(
    () => scoped.readFile('/memories/agents/@omadia/agent-odoo-hr/notes.md'),
    MemoryScopeViolation,
  );
  await assert.rejects(
    () =>
      scoped.writeFile(
        '/memories/agents/@omadia/agent-odoo-hr/leak.md',
        'nope',
      ),
    MemoryScopeViolation,
  );
});

test('SC-003: shared plugin → both Agents see the plugin\'s memory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omadia-mem-'));
  const inner = new FilesystemMemoryStore(dir);
  await inner.writeFile(
    '/memories/agents/@omadia/agent-shared/notes.md',
    'shared',
  );

  const pub = new ScopedMemoryStore({
    agentSlug: 'public',
    scope: ['agent:@omadia/agent-shared:*', 'core'],
    inner,
  });
  const gen = new ScopedMemoryStore({
    agentSlug: 'general',
    scope: ['agent:@omadia/agent-shared:*', 'core'],
    inner,
  });

  assert.equal(
    await pub.readFile('/memories/agents/@omadia/agent-shared/notes.md'),
    'shared',
  );
  assert.equal(
    await gen.readFile('/memories/agents/@omadia/agent-shared/notes.md'),
    'shared',
  );
});

test('SC-003: removing a plugin makes its memory entry invisible (persists in storage)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omadia-mem-'));
  const inner = new FilesystemMemoryStore(dir);
  await inner.writeFile(
    '/memories/agents/@omadia/agent-confluence/notes.md',
    'persists',
  );

  const before = new ScopedMemoryStore({
    agentSlug: 'public',
    scope: ['agent:@omadia/agent-confluence:*', 'core'],
    inner,
  });
  assert.equal(
    await before.readFile('/memories/agents/@omadia/agent-confluence/notes.md'),
    'persists',
  );

  // Operator removes the plugin from the Public Agent — the scope shrinks
  // to `core` only.
  const after = new ScopedMemoryStore({
    agentSlug: 'public',
    scope: ['core'],
    inner,
  });
  assert.equal(
    await after.fileExists('/memories/agents/@omadia/agent-confluence/notes.md'),
    false,
    'invisible to the Agent after the plugin is removed',
  );

  // The underlying file is still there for a future re-enable.
  assert.equal(
    await inner.readFile('/memories/agents/@omadia/agent-confluence/notes.md'),
    'persists',
  );
});

test('T034: core scope grants read access to shared kernel namespaces', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omadia-mem-'));
  const inner = new FilesystemMemoryStore(dir);
  await inner.writeFile('/memories/sessions/abc.md', 'session');
  await inner.writeFile('/memories/chat-sessions/xyz.json', '{}');
  await inner.writeFile('/memories/_brand/logo.md', 'brand');

  const scoped = new ScopedMemoryStore({
    agentSlug: 'public',
    scope: ['core'],
    inner,
  });
  assert.equal(await scoped.fileExists('/memories/sessions/abc.md'), true);
  assert.equal(await scoped.fileExists('/memories/chat-sessions/xyz.json'), true);
  assert.equal(await scoped.fileExists('/memories/_brand/logo.md'), true);
});

test('T035: SessionConfigSnapshot.memoryScope matches the Agent\'s computed scope', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omadia-mem-'));
  const memoryStore = new FilesystemMemoryStore(dir);
  const chatSessionStore = new ChatSessionStore(memoryStore);

  const snap: ConfigSnapshot = {
    agents: [agent('public', '00000000-0000-0000-0000-000000000001')],
    agentPlugins: [
      plugin('00000000-0000-0000-0000-000000000001', '@omadia/agent-confluence'),
    ],
    channelBindings: [],
    platformSettings: { fallbackAgentId: null, updatedAt: new Date(0) },
  };
  const fakeStore: ConfigStore = {
    loadSnapshot: () => Promise.resolve(snap),
  } as unknown as ConfigStore;

  const registry = new OrchestratorRegistry(fakeStore, deps(memoryStore), {
    defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
    pluginLookup: lookup,
  });
  await registry.start();

  const active = registry.get('public');
  assert.ok(active);
  assert.deepEqual([...active.memoryScope].sort(), [
    'agent:@omadia/agent-confluence:*',
    'core',
  ]);

  const sessionSnap = registry.snapshotForAgent('public');
  assert.deepEqual([...sessionSnap!.memoryScope].sort(), [
    'agent:@omadia/agent-confluence:*',
    'core',
  ]);

  // Capture-on-first-use carries the scope through to the persisted session.
  await chatSessionStore.save({
    id: 'sess1',
    title: 't',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  });
  const captured = await chatSessionStore.captureSnapshot('sess1', () =>
    Promise.resolve(sessionSnap!),
  );
  assert.deepEqual([...captured!.memoryScope].sort(), [
    'agent:@omadia/agent-confluence:*',
    'core',
  ]);
});
