/**
 * US6 / T027 — session-snapshot + force-invalidate acceptance tests.
 *
 * Drives the `ChatSessionStore` (`captureSnapshot` / `clearSnapshot`) and
 * the registry's `forceInvalidate` to demonstrate SC-006:
 *
 *  1. Snapshot is captured at first-use and pinned for the session's
 *     entire lifetime (subsequent captureSnapshot calls reuse it).
 *  2. A registry rebuild of Agent A's Orchestrator does NOT mutate the
 *     pinned snapshot on existing sessions.
 *  3. A NEW session captured after the rebuild reflects the new config.
 *  4. `forceInvalidate(slug, 'drain', ...)` clears the snapshot AND keeps
 *     the session history intact.
 *  5. `forceInvalidate(slug, 'kill', ...)` deletes the session entry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import Anthropic from '@anthropic-ai/sdk';
import { InMemoryMemoryStore } from '@omadia/memory';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type {
  EntityRefBus,
  KnowledgeGraph,
} from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import {
  ChatSessionStore,
  type ChatSession,
} from '../packages/harness-orchestrator/src/chatSessionStore.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type {
  AgentRow,
  ConfigSnapshot,
  ConfigStore,
} from '../packages/harness-orchestrator/src/registry/configStore.js';
import { OrchestratorRegistry } from '../packages/harness-orchestrator/src/registry/index.js';

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

function deps(memoryStore: InMemoryMemoryStore): OrchestratorDeps {
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

class MutableFakeStore implements Pick<ConfigStore, 'loadSnapshot'> {
  private snapshot: ConfigSnapshot;
  constructor(initial: ConfigSnapshot) {
    this.snapshot = initial;
  }
  set(snap: ConfigSnapshot): void {
    this.snapshot = snap;
  }
  loadSnapshot(): Promise<ConfigSnapshot> {
    return Promise.resolve(this.snapshot);
  }
}

const baseSnapshot: ConfigSnapshot = {
  agents: [
    agent('public', '00000000-0000-0000-0000-000000000001'),
    agent('general', '00000000-0000-0000-0000-000000000002'),
  ],
  agentPlugins: [
    {
      agentId: '00000000-0000-0000-0000-000000000001',
      pluginId: '@omadia/agent-seo-analyst',
      config: {},
      enabled: true,
      createdAt: new Date(0),
    },
  ],
  channelBindings: [],
  platformSettings: { fallbackAgentId: null, updatedAt: new Date(0) },
};

async function setup() {
  const memoryStore = new InMemoryMemoryStore();
  const chatSessionStore = new ChatSessionStore(memoryStore);
  const cfgStore = new MutableFakeStore(baseSnapshot);
  const registry = new OrchestratorRegistry(
    cfgStore as ConfigStore,
    deps(memoryStore),
    {
      defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
    },
  );
  await registry.start();
  return { memoryStore, chatSessionStore, cfgStore, registry };
}

async function makeSession(
  store: ChatSessionStore,
  id: string,
): Promise<ChatSession> {
  const session: ChatSession = {
    id,
    title: 'test',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  await store.save(session);
  return session;
}

test('T024: captureSnapshot pins on first use; second call reuses the same snapshot', async () => {
  const { chatSessionStore, registry } = await setup();
  await makeSession(chatSessionStore, 'sess1');

  const first = await chatSessionStore.captureSnapshot('sess1', () =>
    Promise.resolve(registry.snapshotForAgent('public')!),
  );
  const second = await chatSessionStore.captureSnapshot('sess1', () =>
    Promise.resolve(registry.snapshotForAgent('public')!),
  );

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.agentSlug, 'public');
  assert.equal(second.capturedAt, first.capturedAt, 'second call must reuse');
  assert.deepEqual(second.pluginIds, ['@omadia/agent-seo-analyst']);
});

test('SC-006: a registry rebuild does NOT mutate the snapshot pinned on an existing session', async () => {
  const { chatSessionStore, cfgStore, registry } = await setup();
  await makeSession(chatSessionStore, 'sess1');

  const pinned = await chatSessionStore.captureSnapshot('sess1', () =>
    Promise.resolve(registry.snapshotForAgent('public')!),
  );
  assert.ok(pinned);
  assert.deepEqual(pinned.pluginIds, ['@omadia/agent-seo-analyst']);

  // Mutate the DB: add a second plugin to public + a privacy_profile flip.
  cfgStore.set({
    ...baseSnapshot,
    agents: [
      agent('public', '00000000-0000-0000-0000-000000000001', {
        privacyProfile: 'strict',
      }),
      agent('general', '00000000-0000-0000-0000-000000000002'),
    ],
    agentPlugins: [
      ...baseSnapshot.agentPlugins,
      {
        agentId: '00000000-0000-0000-0000-000000000001',
        pluginId: '@omadia/agent-odoo-hr',
        config: {},
        enabled: true,
        createdAt: new Date(0),
      },
    ],
  });
  await registry.reload();

  // The session's pinned snapshot is unchanged — captureSnapshot returns
  // the same data even after the rebuild.
  const reread = await chatSessionStore.captureSnapshot('sess1', () =>
    Promise.resolve(registry.snapshotForAgent('public')!),
  );
  assert.deepEqual(reread!.pluginIds, ['@omadia/agent-seo-analyst']);
  assert.equal(reread!.capturedAt, pinned.capturedAt);
});

test('SC-006: a NEW session reflects the post-reload config', async () => {
  const { chatSessionStore, cfgStore, registry } = await setup();

  cfgStore.set({
    ...baseSnapshot,
    agentPlugins: [
      ...baseSnapshot.agentPlugins,
      {
        agentId: '00000000-0000-0000-0000-000000000001',
        pluginId: '@omadia/agent-odoo-hr',
        config: {},
        enabled: true,
        createdAt: new Date(0),
      },
    ],
  });
  await registry.reload();

  await makeSession(chatSessionStore, 'sess2');
  const fresh = await chatSessionStore.captureSnapshot('sess2', () =>
    Promise.resolve(registry.snapshotForAgent('public')!),
  );
  assert.deepEqual(fresh!.pluginIds.sort(), [
    '@omadia/agent-odoo-hr',
    '@omadia/agent-seo-analyst',
  ]);
});

test('T026: forceInvalidate drain clears the snapshot AND keeps history intact', async () => {
  const { chatSessionStore, registry } = await setup();
  await makeSession(chatSessionStore, 'sess1');
  await chatSessionStore.captureSnapshot('sess1', () =>
    Promise.resolve(registry.snapshotForAgent('public')!),
  );

  // Append a message so we can prove drain preserved it.
  const before = (await chatSessionStore.get('sess1'))!;
  before.messages.push({
    id: 'm1',
    role: 'user',
    content: 'hello',
    startedAt: Date.now(),
  });
  await chatSessionStore.save(before);

  const affected = await registry.forceInvalidate(
    'public',
    'drain',
    chatSessionStore,
  );
  assert.equal(affected, 1);

  const after = (await chatSessionStore.get('sess1'))!;
  assert.equal(after.snapshot, undefined, 'snapshot is cleared');
  assert.equal(after.messages.length, 1, 'history preserved');
  assert.equal(after.messages[0]!.content, 'hello');
});

test('T026: forceInvalidate kill deletes the session entry entirely', async () => {
  const { chatSessionStore, registry } = await setup();
  await makeSession(chatSessionStore, 'sess1');
  await chatSessionStore.captureSnapshot('sess1', () =>
    Promise.resolve(registry.snapshotForAgent('public')!),
  );

  const affected = await registry.forceInvalidate(
    'public',
    'kill',
    chatSessionStore,
  );
  assert.equal(affected, 1);

  const after = await chatSessionStore.get('sess1');
  assert.equal(after, null, 'session entry is deleted');
});

test('T026: forceInvalidate is scoped to the named slug — other Agents\' sessions are untouched', async () => {
  const { chatSessionStore, registry } = await setup();
  await makeSession(chatSessionStore, 'pub-sess');
  await makeSession(chatSessionStore, 'gen-sess');
  await chatSessionStore.captureSnapshot('pub-sess', () =>
    Promise.resolve(registry.snapshotForAgent('public')!),
  );
  await chatSessionStore.captureSnapshot('gen-sess', () =>
    Promise.resolve(registry.snapshotForAgent('general')!),
  );

  const affected = await registry.forceInvalidate(
    'public',
    'kill',
    chatSessionStore,
  );
  assert.equal(affected, 1);
  assert.equal(await chatSessionStore.get('pub-sess'), null);
  assert.ok(await chatSessionStore.get('gen-sess'), 'general session preserved');
});

test('T025: lookupForSession routes by snapshot agentSlug, surviving an Orchestrator rebuild', async () => {
  const { chatSessionStore, cfgStore, registry } = await setup();
  await makeSession(chatSessionStore, 'sess1');
  const snap = await chatSessionStore.captureSnapshot('sess1', () =>
    Promise.resolve(registry.snapshotForAgent('public')!),
  );

  const orchBefore = registry.lookupForSession(snap!);
  assert.ok(orchBefore);

  // Trigger a rebuild via privacy_profile flip.
  cfgStore.set({
    ...baseSnapshot,
    agents: [
      agent('public', '00000000-0000-0000-0000-000000000001', {
        privacyProfile: 'strict',
      }),
      agent('general', '00000000-0000-0000-0000-000000000002'),
    ],
  });
  await registry.reload();

  // lookupForSession still resolves the snapshot's slug — but to the
  // newly-built Orchestrator instance (the snapshot is the routing key,
  // not a hard reference). The session's snapshot remains pinned; the
  // route surface caller decides whether to honor the pin (drain) or
  // re-snapshot on next turn (which would happen via clearSnapshot).
  const orchAfter = registry.lookupForSession(snap!);
  assert.ok(orchAfter, 'still resolves');
  assert.notEqual(orchAfter, orchBefore, 'new instance after rebuild');
});
