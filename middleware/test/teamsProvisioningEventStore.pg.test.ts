/**
 * #915 — `agent_teams_provisioning_events` against a real Postgres.
 *
 * The schema is applied from the ACTUAL migration files (0049, then 0053),
 * twice, so this suite doubles as the double-apply proof the migrations
 * README demands and pins the two things the store and the migration have to
 * agree on: the status CHECK constraint, and the foreign key that ties an
 * event to the identity it describes.
 *
 * Runs in its own schema (search_path pinned per connection), mirroring
 * `agentTeamsIdentityStore.pg.test.ts`, so parallel pg suites never collide.
 * Skips cleanly when no test Postgres is reachable.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { AgentTeamsIdentityStore } from '../src/platform/agentTeamsIdentityStore.js';
import {
  MAX_EVENTS_PER_AGENT,
  TeamsProvisioningEventStatusError,
  TeamsProvisioningEventStore,
} from '../src/platform/teamsProvisioningEventStore.js';
import type { TeamsProvisioningEventSink } from '../src/services/teamsProvisioningJob.js';
import type { OperatorTeamsEventStore } from '../src/routes/operatorAgents.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'teamsProvisioningEventStore',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

const SCHEMA = `teams_prov_events_${String(process.pid)}`;

describe(
  'TeamsProvisioningEventStore against a real Postgres (#915)',
  { skip: !pgAvailable },
  () => {
    let pool: Pool;
    let store: TeamsProvisioningEventStore;
    let identities: AgentTeamsIdentityStore;

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
      for (const file of [
        '0049_agent_teams_identities.sql',
        '0053_agent_teams_provisioning_events.sql',
      ]) {
        const sql = await readFile(resolve(MIGRATIONS_DIR, file), 'utf8');
        // Applied TWICE on purpose — the migrations README requires every
        // file to be re-applicable (the schema CI double-applies).
        await pool.query(sql);
        await pool.query(sql);
      }
      store = new TeamsProvisioningEventStore(pool);
      identities = new AgentTeamsIdentityStore(pool);
    });

    beforeEach(async () => {
      await pool.query('TRUNCATE agent_teams_identities CASCADE');
      await identities.ensureForAgent({
        agentId: 'agent-1',
        botSlug: 'hr-bot',
        displayName: 'HR Bot',
      });
    });

    after(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await pool.end();
    });

    it('writes an event and reads it back whole', async () => {
      await store.record({
        agentId: 'agent-1',
        step: 'bot_created',
        status: 'retrying',
        attempt: 3,
        detail: 'retry_in_ms=8000;max_attempts=5',
      });

      const [event] = await store.listRecent('agent-1', 10);
      assert.ok(event);
      assert.equal(event.agentId, 'agent-1');
      assert.equal(event.step, 'bot_created');
      assert.equal(event.status, 'retrying');
      assert.equal(event.attempt, 3);
      assert.equal(event.detail, 'retry_in_ms=8000;max_attempts=5');
      assert.ok(event.at instanceof Date);
      // int8 crosses the wire as text; the id is an ordering handle, never a
      // number this code does arithmetic on.
      assert.equal(typeof event.id, 'string');
    });

    it('returns the newest first — the order the timeline renders in', async () => {
      for (const step of ['app_registered', 'bot_created', 'package_built']) {
        await store.record({ agentId: 'agent-1', step, status: 'succeeded' });
      }

      const events = await store.listRecent('agent-1', 10);
      assert.deepEqual(
        events.map((e) => e.step),
        ['package_built', 'bot_created', 'app_registered'],
      );
    });

    it('scopes reads to one agent', async () => {
      await identities.ensureForAgent({
        agentId: 'agent-2',
        botSlug: 'sales-bot',
        displayName: 'Sales Bot',
      });
      await store.record({ agentId: 'agent-1', step: 'run', status: 'started' });
      await store.record({ agentId: 'agent-2', step: 'run', status: 'started' });

      const events = await store.listRecent('agent-1', 10);
      assert.equal(events.length, 1);
      assert.equal(events[0]?.agentId, 'agent-1');
    });

    // ─── Retention ────────────────────────────────────────────────────

    it('clearForAgent drops that agent`s log and nobody else`s', async () => {
      await identities.ensureForAgent({
        agentId: 'agent-2',
        botSlug: 'sales-bot',
        displayName: 'Sales Bot',
      });
      await store.record({ agentId: 'agent-1', step: 'run', status: 'started' });
      await store.record({ agentId: 'agent-1', step: 'run', status: 'failed' });
      await store.record({ agentId: 'agent-2', step: 'run', status: 'started' });

      const removed = await store.clearForAgent('agent-1');

      assert.equal(removed, 2);
      assert.deepEqual(await store.listRecent('agent-1', 10), []);
      assert.equal((await store.listRecent('agent-2', 10)).length, 1);
    });

    it('caps the log per agent even when the clear never ran', async () => {
      // The primary retention is the clear at run start. This is the belt to
      // that brace: the clear is best-effort like every other write from the
      // runner, so a Postgres hiccup at run start must not let a long-lived
      // agent accumulate forever.
      const overflow = MAX_EVENTS_PER_AGENT + 25;
      for (let i = 0; i < overflow; i += 1) {
        await store.record({
          agentId: 'agent-1',
          step: 'run',
          status: 'progress',
          detail: `n=${String(i)}`,
        });
      }

      const total = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM agent_teams_provisioning_events WHERE agent_id = $1',
        ['agent-1'],
      );
      assert.equal(Number(total.rows[0]?.count), MAX_EVENTS_PER_AGENT);
      // It is the OLDEST that go — the newest events are what an operator is
      // looking at.
      const [newest] = await store.listRecent('agent-1', 1);
      assert.equal(newest?.detail, `n=${String(overflow - 1)}`);
    });

    it('goes with the identity it describes (ON DELETE CASCADE)', async () => {
      await store.record({ agentId: 'agent-1', step: 'run', status: 'started' });
      await pool.query('DELETE FROM agent_teams_identities WHERE agent_id = $1', [
        'agent-1',
      ]);
      assert.deepEqual(await store.listRecent('agent-1', 10), []);
    });

    // ─── Guards ───────────────────────────────────────────────────────

    it('rejects a status outside the vocabulary before it reaches the CHECK', async () => {
      await assert.rejects(
        () =>
          store.record({
            agentId: 'agent-1',
            step: 'run',
            // Caught in TypeScript by the union; a JS caller (or a drifted
            // mirror) gets a named error instead of a raw constraint
            // violation.
            status: 'in_progress' as never,
          }),
        TeamsProvisioningEventStatusError,
      );
    });

    it('drops an attempt number that is not a positive integer', async () => {
      // Writing 0 or NaN would make the UI announce "attempt 0 of 5" for a
      // step that never failed.
      await store.record({
        agentId: 'agent-1',
        step: 'run',
        status: 'started',
        attempt: 0,
      });
      const [event] = await store.listRecent('agent-1', 1);
      assert.equal(event?.attempt, null);
    });

    it('bounds the page size a caller can ask for', async () => {
      for (let i = 0; i < 5; i += 1) {
        await store.record({ agentId: 'agent-1', step: 'run', status: 'progress' });
      }
      assert.equal((await store.listRecent('agent-1', 2)).length, 2);
      // A nonsensical limit degrades to a sane page rather than to an error
      // or to the whole table.
      assert.equal((await store.listRecent('agent-1', -1)).length, 1);
      assert.equal((await store.listRecent('agent-1')).length, 5);
    });

    it('satisfies both consumer ports structurally', () => {
      // The runner's sink and the route's reader are structural subsets of
      // this class. Assigning here is the compile-time proof that neither
      // drifted — a rename would break this line, not production.
      const sink: TeamsProvisioningEventSink = store;
      const reader: OperatorTeamsEventStore = store;
      assert.ok(sink);
      assert.ok(reader);
    });
  },
);
