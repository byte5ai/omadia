/**
 * Validation guard on sub-agent `model` writes (issue #296 follow-up).
 *
 * `createSubAgent` / `updateSubAgent` accept a free-form `model: string | null`.
 * `null` (or empty) means "inherit parent agent" and skips validation; a
 * non-empty value must resolve via `@omadia/llm-provider` for the same reason
 * orchestrator routing does — an unknown id would 404 at every turn the
 * sub-agent runs.
 *
 * Pool is stubbed: the validator throws BEFORE any SQL is sent, so unknown ids
 * never reach `INSERT`/`UPDATE`. The stub also asserts the inverse — accepted
 * writes DO reach SQL.
 */

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import type { Pool } from 'pg';

import {
  clearExternalModels,
  registerExternalModels,
  type ModelInfo,
} from '@omadia/llm-provider';

import { AgentGraphStore } from '../packages/harness-orchestrator/src/registry/agentGraphStore.js';
import { ConfigValidationError } from '../packages/harness-orchestrator/src/registry/configStore.js';

const OPUS: ModelInfo = {
  id: 'anthropic:claude-opus-4-8',
  provider: 'anthropic',
  modelId: 'claude-opus-4-8',
  label: 'Claude Opus 4.8',
  class: 'frontier',
  maxTokens: 16384,
  contextWindow: 200000,
  vision: true,
  aliases: ['opus'],
};

const GPT: ModelInfo = {
  id: 'openai:gpt-5.5',
  provider: 'openai',
  modelId: 'gpt-5.5',
  label: 'GPT-5.5',
  class: 'frontier',
  maxTokens: 16384,
  contextWindow: 400000,
  vision: true,
  aliases: [],
};

beforeEach(() => {
  clearExternalModels();
  registerExternalModels([OPUS, GPT]);
});

interface QueryCall {
  sql: string;
  params: unknown[];
}

/** Capture every `query()` call; return a deterministic `SubAgentDbRow`-shaped
 *  result so `mapSubAgent` succeeds and the call site doesn't crash on `rows[0]`. */
function fakePool(): { pool: Pool; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return {
        rows: [
          {
            id: '00000000-0000-0000-0000-0000000000aa',
            parent_agent_id: '00000000-0000-0000-0000-000000000001',
            name: 'researcher',
            skill_id: null,
            model: (params[3] ?? params[2] ?? null) as string | null,
            max_tokens: null,
            max_iterations: null,
            system_prompt_override: null,
            status: 'enabled',
            position: null,
            created_at: new Date(0),
            updated_at: new Date(0),
          },
        ],
      };
    },
  } as unknown as Pool;
  return { pool, calls };
}

test('createSubAgent rejects an unknown model id BEFORE touching the DB', async () => {
  const { pool, calls } = fakePool();
  const store = new AgentGraphStore(pool);
  await assert.rejects(
    () =>
      store.createSubAgent({
        parentAgentId: '00000000-0000-0000-0000-000000000001',
        name: 'researcher',
        model: 'gpt-99-not-registered',
      }),
    (err) =>
      err instanceof ConfigValidationError &&
      /subAgent\.model 'gpt-99-not-registered'/.test(err.message),
  );
  assert.equal(calls.length, 0, 'no SQL was sent for the rejected write');
});

test('createSubAgent accepts a registered model and persists the row', async () => {
  const { pool, calls } = fakePool();
  const store = new AgentGraphStore(pool);
  const row = await store.createSubAgent({
    parentAgentId: '00000000-0000-0000-0000-000000000001',
    name: 'researcher',
    model: 'claude-opus-4-8',
  });
  assert.equal(row.model, 'claude-opus-4-8');
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /INSERT INTO agent_subagents/);
});

test('createSubAgent treats null / empty model as "inherit" — no validation, write fires', async () => {
  const { pool, calls } = fakePool();
  const store = new AgentGraphStore(pool);
  // null = clear / inherit parent; must NOT trigger the registered-model check.
  await store.createSubAgent({
    parentAgentId: '00000000-0000-0000-0000-000000000001',
    name: 'r1',
    model: null,
  });
  // empty string round-trips from the UI dropdown's "(default)" choice — same
  // semantic as null per agentGraphStore guard.
  await store.createSubAgent({
    parentAgentId: '00000000-0000-0000-0000-000000000001',
    name: 'r2',
    model: '',
  });
  assert.equal(calls.length, 2, 'both writes hit SQL');
});

test('updateSubAgent rejects an unknown model id BEFORE touching the DB', async () => {
  const { pool, calls } = fakePool();
  const store = new AgentGraphStore(pool);
  await assert.rejects(
    () =>
      store.updateSubAgent('00000000-0000-0000-0000-0000000000aa', {
        model: 'definitely-not-real',
      }),
    (err) =>
      err instanceof ConfigValidationError &&
      /subAgent\.model 'definitely-not-real'/.test(err.message),
  );
  assert.equal(calls.length, 0);
});

test('updateSubAgent without a `model` patch skips validation entirely', async () => {
  const { pool, calls } = fakePool();
  const store = new AgentGraphStore(pool);
  await store.updateSubAgent('00000000-0000-0000-0000-0000000000aa', {
    name: 'renamed',
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /UPDATE agent_subagents/);
});

// ── clear path (issue #296 MAJOR#2) ──────────────────────────────────────
// `model = COALESCE($4, model)` can NEVER clear the column — COALESCE(NULL,
// model) keeps the old value. The write must use an explicit "was model in the
// patch?" guard so `null` clears to NULL while `undefined` keeps.

test('createSubAgent normalises empty-string model to NULL (clean data)', async () => {
  const { pool, calls } = fakePool();
  const store = new AgentGraphStore(pool);
  await store.createSubAgent({
    parentAgentId: '00000000-0000-0000-0000-000000000001',
    name: 'r',
    model: '   ',
  });
  // INSERT param $4 is the model column — must be NULL, not '' / whitespace.
  assert.equal(calls[0]!.params[3], null, 'empty model persisted as NULL');
});

test('updateSubAgent clears model to NULL when patch.model is null', async () => {
  const { pool, calls } = fakePool();
  const store = new AgentGraphStore(pool);
  const row = await store.updateSubAgent('00000000-0000-0000-0000-0000000000aa', {
    model: null,
  });
  const { sql, params } = calls[0]!;
  // The write must NOT COALESCE the model column (that would keep the old
  // value); it must branch on the "provided" guard and write NULL.
  assert.doesNotMatch(sql, /model\s+=\s+COALESCE/);
  assert.match(sql, /model\s+=\s+CASE WHEN \$10 THEN \$4 ELSE model END/);
  assert.equal(params[3], null, 'model value param is NULL');
  assert.equal(params[9], true, 'model-provided guard is true → clears');
  assert.equal(row.model, null);
});

test('updateSubAgent clears model to NULL when patch.model is empty string', async () => {
  const { pool, calls } = fakePool();
  const store = new AgentGraphStore(pool);
  await store.updateSubAgent('00000000-0000-0000-0000-0000000000aa', {
    model: '',
  });
  assert.equal(calls[0]!.params[3], null);
  assert.equal(calls[0]!.params[9], true);
});

test('updateSubAgent keeps model untouched when patch omits it (undefined)', async () => {
  const { pool, calls } = fakePool();
  const store = new AgentGraphStore(pool);
  await store.updateSubAgent('00000000-0000-0000-0000-0000000000aa', {
    name: 'renamed',
  });
  // model-provided guard is false → the CASE keeps the existing column.
  assert.equal(calls[0]!.params[9], false, 'model-provided guard is false → keeps');
});

// ── active-provider scoping (issue #296 MAJOR#3) ─────────────────────────

test('createSubAgent rejects a cross-provider model when activeProvider is set', async () => {
  const { pool, calls } = fakePool();
  const store = new AgentGraphStore(pool);
  await assert.rejects(
    () =>
      store.createSubAgent(
        {
          parentAgentId: '00000000-0000-0000-0000-000000000001',
          name: 'researcher',
          model: 'openai:gpt-5.5',
        },
        'anthropic',
      ),
    (err) =>
      err instanceof ConfigValidationError && /cross-provider/.test(err.message),
  );
  assert.equal(calls.length, 0, 'no SQL for a rejected cross-provider write');
});

test('updateSubAgent rejects a cross-provider model when activeProvider is set', async () => {
  const { pool, calls } = fakePool();
  const store = new AgentGraphStore(pool);
  await assert.rejects(
    () =>
      store.updateSubAgent(
        '00000000-0000-0000-0000-0000000000aa',
        { model: 'openai:gpt-5.5' },
        'anthropic',
      ),
    (err) =>
      err instanceof ConfigValidationError && /cross-provider/.test(err.message),
  );
  assert.equal(calls.length, 0);
});
