/**
 * W1a (#860) — `agent_teams_identities` store against a real Postgres.
 *
 * The schema is applied from the ACTUAL migration file (0049), twice, so
 * this suite doubles as the double-apply proof the migrations README
 * demands, and so the store and the migration can never drift apart
 * silently: the exported state union is exercised against the real CHECK
 * constraint, the one-identity-per-agent rule against the real primary key,
 * and the cross-agent bot-slug collision against the real UNIQUE constraint.
 *
 * Runs in its own schema (search_path pinned per connection), mirroring
 * coreMigrations.pg.test.ts, so parallel pg suites never collide. Skips
 * cleanly when no test Postgres is reachable.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import {
  AgentTeamsIdentityStore,
  AgentTeamsIdentityNotFoundError,
  AgentTeamsIdentityStateError,
  BotSlugTakenError,
  TEAMS_PROVISIONING_STATES,
  type TeamsProvisioningState,
} from '../src/platform/agentTeamsIdentityStore.js';
import type { TeamsIdentityJobStore } from '../src/services/teamsProvisioningJob.js';
import type { OperatorTeamsIdentityStore } from '../src/routes/operatorAgents.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'agentTeamsIdentityStore',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

/** The files that build the table this store reads, in order. 0054 adds
 *  `target_kind`, which is part of the store's SELECT list. */
const MIGRATION_FILES = [
  '0049_agent_teams_identities.sql',
  // 0051 creates `agent_teams_installs`, which 0054 also alters — applying
  // 0054 without it fails on a relation that does not exist.
  '0051_agent_teams_installs.sql',
  '0054_agent_teams_target_kind.sql',
  '0055_agent_teams_app_object_id.sql',
  // 0060 adds `error_code` / `error_detail` (#897), both in the SELECT list.
  '0060_agent_teams_error_code.sql',
] as const;

const SCHEMA = `w1a_teams_ident_${String(process.pid)}`;

describe('W1a AgentTeamsIdentityStore against a real Postgres', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: AgentTeamsIdentityStore;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({
      connectionString: PG_URL,
      max: 2,
      options: `-c search_path=${SCHEMA}`,
    });
    for (const file of MIGRATION_FILES) {
      const migration = await readFile(resolve(MIGRATIONS_DIR, file), 'utf8');
      // Applied TWICE on purpose — the migrations README requires every file
      // to be re-applicable (the schema CI gate double-applies).
      await pool.query(migration);
      await pool.query(migration);
    }
    store = new AgentTeamsIdentityStore(pool);
  });

  beforeEach(async () => {
    // CASCADE because `agent_teams_installs` (0051) carries a foreign key
    // into this table — the same reason the event-store suite truncates with
    // it.
    await pool.query('TRUNCATE agent_teams_identities CASCADE');
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it('is a drop-in TeamsIdentityJobStore for the provisioning job runner', () => {
    // Compile-time pin: the runner's structural port must stay satisfied.
    const jobStore: TeamsIdentityJobStore = store;
    assert.ok(jobStore);
  });

  it('is a drop-in OperatorTeamsIdentityStore for the operator router (W2a #860)', () => {
    // Compile-time pin, the counterpart of the job-store one above: the
    // team↔agent read model derives the installed team from `teamId`, so a
    // store that stopped exposing it would leave GET /:slug/teams reporting
    // "no installs" forever instead of failing.
    const routerStore: OperatorTeamsIdentityStore = store;
    assert.ok(routerStore);
  });

  it('getByAgentId returns undefined for an agent without an identity', async () => {
    assert.equal(await store.getByAgentId('nobody'), undefined);
  });

  it('ensureForAgent creates a pending row and is create-if-absent', async () => {
    const created = await store.ensureForAgent({
      agentId: 'agent-1',
      botSlug: 'hr-bot',
      displayName: 'HR Bot',
      teamId: '19:team-a',
    });
    assert.equal(created.state, 'pending');
    assert.equal(created.botSlug, 'hr-bot');
    assert.equal(created.teamId, '19:team-a');
    assert.equal(created.appId, null);
    assert.equal(created.lastError, null);

    // Re-ensure with different identity fields: row wins, only the install
    // target is refreshed.
    const again = await store.ensureForAgent({
      agentId: 'agent-1',
      botSlug: 'other-slug',
      displayName: 'Other Name',
      teamId: '19:team-b',
    });
    assert.equal(again.botSlug, 'hr-bot', 'bot_slug is not re-applied');
    assert.equal(again.displayName, 'HR Bot', 'display_name is not re-applied');
    assert.equal(again.teamId, '19:team-b', 'team_id follows the latest request');

    // Without a teamId the stored target is kept.
    const kept = await store.ensureForAgent({
      agentId: 'agent-1',
      botSlug: 'hr-bot',
      displayName: 'HR Bot',
    });
    assert.equal(kept.teamId, '19:team-b');
  });

  it("a second agent claiming the same bot slug fails loudly (BotSlugTakenError)", async () => {
    await store.ensureForAgent({
      agentId: 'agent-1',
      botSlug: 'hr-bot',
      displayName: 'HR Bot',
    });
    await assert.rejects(
      store.ensureForAgent({
        agentId: 'agent-2',
        botSlug: 'hr-bot',
        displayName: 'Impostor',
      }),
      (err: unknown) => {
        assert.ok(err instanceof BotSlugTakenError);
        assert.equal(err.code, 'bot_slug_taken');
        return true;
      },
    );
    // agent-2 got no row.
    assert.equal(await store.getByAgentId('agent-2'), undefined);
  });

  it('update walks the chain states and persists step evidence', async () => {
    await store.ensureForAgent({
      agentId: 'agent-1',
      botSlug: 'hr-bot',
      displayName: 'HR Bot',
    });
    const registered = await store.update('agent-1', {
      state: 'app_registered',
      appId: 'app-123',
      tenantId: 'tenant-9',
      lastError: null,
    });
    assert.equal(registered.state, 'app_registered');
    assert.equal(registered.appId, 'app-123');
    assert.equal(registered.tenantId, 'tenant-9');

    const uploaded = await store.update('agent-1', {
      state: 'catalog_uploaded',
      teamsAppId: 'catalog-77',
      teamsAppExternalId: 'ext-1',
    });
    assert.equal(uploaded.state, 'catalog_uploaded');
    assert.equal(uploaded.teamsAppId, 'catalog-77');
    assert.equal(uploaded.appId, 'app-123', 'earlier evidence survives');

    const failed = await store.update('agent-1', {
      state: 'failed',
      lastError: 'consent_missing: scopes [AppCatalog.ReadWrite.All]',
    });
    assert.equal(failed.state, 'failed');
    assert.match(failed.lastError ?? '', /consent_missing/);

    // Clearing the error with null.
    const cleared = await store.update('agent-1', { lastError: null });
    assert.equal(cleared.lastError, null);
  });

  it('update surfaces unknown agents and out-of-union states — never a silent no-op', async () => {
    await assert.rejects(
      store.update('nobody', { state: 'app_registered' }),
      AgentTeamsIdentityNotFoundError,
    );
    await store.ensureForAgent({
      agentId: 'agent-1',
      botSlug: 'hr-bot',
      displayName: 'HR Bot',
    });
    await assert.rejects(
      store.update('agent-1', {
        state: 'exploded' as TeamsProvisioningState,
      }),
      AgentTeamsIdentityStateError,
    );
  });

  it('the CHECK constraint enforces exactly the exported state union', async () => {
    // Every union member is accepted…
    for (const [i, state] of TEAMS_PROVISIONING_STATES.entries()) {
      await pool.query(
        `INSERT INTO agent_teams_identities (agent_id, bot_slug, display_name, state)
         VALUES ($1, $2, $3, $4)`,
        [`check-${String(i)}`, `check-bot-${String(i)}`, 'Check', state],
      );
    }
    // …and anything else is rejected by the database itself.
    await assert.rejects(
      pool.query(
        `INSERT INTO agent_teams_identities (agent_id, bot_slug, display_name, state)
         VALUES ('check-x', 'check-bot-x', 'Check', 'exploded')`,
      ),
      (err: unknown) => (err as { code?: string }).code === '23514',
    );
  });

  it('recordEnqueueFailure stores an actionable last_error without touching state', async () => {
    await store.ensureForAgent({
      agentId: 'agent-1',
      botSlug: 'hr-bot',
      displayName: 'HR Bot',
    });
    await store.recordEnqueueFailure('agent-1', 'queue down');
    const row = await store.getByAgentId('agent-1');
    assert.equal(row?.state, 'pending');
    assert.equal(row?.lastError, 'enqueue_failed: queue down');
    // #897 — coded explicitly, so the row never depends on the classifier.
    assert.equal(row?.errorCode, 'unknown');
    assert.equal(row?.errorDetail, null);
  });

  it('update round-trips error_code + error_detail (JSONB) with last_error (#897)', async () => {
    await store.ensureForAgent({ agentId: 'agent-1', botSlug: 'hr-bot', displayName: 'HR Bot' });
    const written = await store.update('agent-1', {
      state: 'failed',
      lastError: 'consent_missing: admin consent required for scopes [A, B]',
      errorCode: 'consent_missing',
      errorDetail: { scopes: ['A', 'B'] },
    });
    assert.equal(written.errorCode, 'consent_missing');
    assert.deepEqual(written.errorDetail, { scopes: ['A', 'B'] });
    const read = await store.getByAgentId('agent-1');
    assert.equal(read?.errorCode, 'consent_missing');
    assert.deepEqual(read?.errorDetail, { scopes: ['A', 'B'] });
    const { rows } = await pool.query<{ t: string }>(
      `SELECT jsonb_typeof(error_detail) AS t FROM agent_teams_identities WHERE agent_id = 'agent-1'`,
    );
    assert.equal(rows[0]?.t, 'object', 'stored as a JSON object, not a string or array literal');
  });

  it('a last_error write without a code NULLs both columns — no stale code (#897)', async () => {
    await store.ensureForAgent({ agentId: 'agent-1', botSlug: 'hr-bot', displayName: 'HR Bot' });
    await store.update('agent-1', {
      lastError: 'throttled: 429 (gave up after 2 attempts; retry after 5s)',
      errorCode: 'throttled',
      errorDetail: { retryAfterSeconds: 5 },
    });
    const next = await store.update('agent-1', { lastError: 'something else' });
    assert.equal(next.lastError, 'something else');
    assert.equal(next.errorCode, null);
    assert.equal(next.errorDetail, null);
    // A patch WITHOUT last_error leaves all three untouched.
    await store.update('agent-1', {
      lastError: 'config_sync_failed: [x]',
      errorCode: 'config_sync_failed',
      errorDetail: { reason: 'x' },
    });
    const untouched = await store.update('agent-1', { state: 'installed' });
    assert.equal(untouched.errorCode, 'config_sync_failed');
    assert.deepEqual(untouched.errorDetail, { reason: 'x' });
  });

  it('clearTeamInstall and resetForRetry clear the structured columns too (#897)', async () => {
    for (const clear of [
      (id: string) => store.clearTeamInstall(id),
      (id: string) => store.resetForRetry(id),
    ]) {
      await store.ensureForAgent({ agentId: 'agent-1', botSlug: 'hr-bot', displayName: 'HR Bot' });
      await store.update('agent-1', {
        state: 'failed',
        lastError: 'arm_not_configured: [f]',
        errorCode: 'arm_not_configured',
        errorDetail: { fields: ['f'] },
      });
      const row = await clear('agent-1');
      assert.equal(row.lastError, null);
      assert.equal(row.errorCode, null);
      assert.equal(row.errorDetail, null);
    }
  });

  it('listResumable returns interrupted runs only (non-terminal, with a team target)', async () => {
    const seed = async (
      agentId: string,
      state: TeamsProvisioningState,
      teamId: string | null,
    ): Promise<void> => {
      await pool.query(
        `INSERT INTO agent_teams_identities (agent_id, bot_slug, display_name, state, team_id)
         VALUES ($1, $2, 'Seed', $3, $4)`,
        [agentId, `bot-${agentId}`, state, teamId],
      );
    };
    await seed('resume-1', 'app_registered', '19:t');
    await seed('resume-2', 'catalog_uploaded', '19:t');
    await seed('done-1', 'installed', '19:t');
    await seed('failed-1', 'failed', '19:t');
    await seed('no-team', 'pending', null);
    const resumable = await store.listResumable();
    assert.deepEqual(
      resumable.map((r) => r.agentId).sort(),
      ['resume-1', 'resume-2'],
    );
  });
});
