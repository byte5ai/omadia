/**
 * Spec 2042 §6 criterion 19, end to end from the database: an agent created
 * without naming a context-memory mode (as the operator API does) is stored
 * in `members` (migration 0099 default), the registry builds it with a
 * `members` binder (`buildForAgent`), and in that mode a recall in a
 * conversation where someone present does not own the knowledge returns
 * nothing of it, while the same recall works when only owners are present.
 *
 * `buildOrchestratorForAgent` keeps `contextMemory ?? 'off'` only for configs
 * without a row (the Postgres-less legacy bundle): a database row always
 * carries a mode, so a fresh agent never reaches that fallback.
 */

import { strict as assert } from 'node:assert';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';
import { Pool } from 'pg';

import { probePgTest } from '../_helpers/pgTestDb.js';

import type { OrchestratorDeps } from '../../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { ContextMemoryMode } from '../../packages/harness-orchestrator/src/memoryBinder.js';
import type { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { buildForAgent } from '../../packages/harness-orchestrator/src/registry/applyDiff.js';
import { ConfigStore } from '../../packages/harness-orchestrator/src/registry/configStore.js';
import { runMultiOrchestratorMigrations } from '../../packages/harness-orchestrator/src/registry/migrator.js';
import {
  CHRIS,
  CHRISTIAN,
  MARCEL,
  NEWBIE,
  QUESTION,
  SECRET,
  answer,
  groupLearns,
  kgSearch,
  roster,
  teamsDm,
  teamsGroup,
  turn,
  world,
} from './memberScopedWorld.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'freshAgentMembersMemory',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const SCHEMA = `fresh_members_${String(process.pid)}`;

function deps(): OrchestratorDeps {
  const names = new Set<string>();
  const nativeToolRegistry = {
    has: (name: string) => names.has(name),
    register: (name: string) => {
      names.add(name);
      return () => names.delete(name);
    },
  } as unknown as NativeToolRegistry;
  return {
    client: new Anthropic({ apiKey: 'test-key' }),
    knowledgeGraph: {} as KnowledgeGraph,
    memoryStore: {} as MemoryStore,
    entityRefBus: {} as EntityRefBus,
    nativeToolRegistry,
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
    assistantIdentity: 'You are the platform assistant.',
  } as unknown as OrchestratorDeps;
}

const sees = (requests: string[]): boolean => requests.some((r) => r.includes(SECRET));

describe('criterion 19 — a fresh agent runs member-scoped memory (pg)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let freshMode: ContextMemoryMode;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 2, options: `-c search_path=${SCHEMA},public` });
    await runMultiOrchestratorMigrations(pool, () => undefined, MIGRATIONS_DIR);

    const store = new ConfigStore(pool);
    // No contextMemory in the input: the column default decides.
    await store.createAgent({ slug: 'team-agent', name: 'Team Agent' });
    const row = (await store.loadSnapshot()).agents.find((a) => a.slug === 'team-agent');
    assert.ok(row);
    const built = buildForAgent(row, deps(), { model: 'm', maxTokens: 100, maxToolIterations: 4 });
    const binder = (built.orchestrator as unknown as { memoryBinder?: { contextMemoryMode: ContextMemoryMode } })
      .memoryBinder;
    assert.ok(binder, 'the built agent has no memory binder');
    freshMode = binder.contextMemoryMode;
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it('criterion 19: a fresh agent row is built with the context-memory ACL in mode `members`', () => {
    assert.equal(freshMode, 'members');
  });

  it('criterion 19: with someone present who does not own the knowledge, the recall returns nothing of it', async () => {
    const w = world(freshMode);
    await groupLearns(w);
    const requests = await turn(w, {
      from: MARCEL,
      origin: teamsGroup('conv-kranich'),
      scope: 'msteams::conv-kranich',
      text: QUESTION,
      members: roster([MARCEL, CHRIS, CHRISTIAN, NEWBIE]),
      script: [kgSearch(), answer('Dazu habe ich nichts.')],
    });
    assert.ok(!sees(requests), 'a non-owner was present and the knowledge reached the model');
  });

  it('criterion 19: the same recall works when only owners are present', async () => {
    const w = world(freshMode);
    await groupLearns(w);
    const inGroup = await turn(w, {
      from: MARCEL,
      origin: teamsGroup('conv-kranich'),
      scope: 'msteams::conv-kranich',
      text: QUESTION,
      members: roster([MARCEL, CHRIS, CHRISTIAN]),
      script: [answer('Ja.')],
    });
    assert.ok(sees(inGroup), 'the owners did not get their own knowledge back');
    const alone = await turn(w, {
      from: MARCEL,
      origin: teamsDm(MARCEL),
      scope: 'msteams::dm-marcel',
      text: QUESTION,
      script: [answer('Ja.')],
    });
    assert.ok(sees(alone), 'an owner alone did not get the knowledge');
  });
});
