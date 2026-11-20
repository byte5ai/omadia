/**
 * Spec 2042 §5.4 / §5.11 (pg, migrations 0097–0099):
 *  - consultation switches and directed grants: default off, revoke, mutual
 *    grants for discussions, the call ledger and its per-day count;
 *  - discretion stores: integration declarations, persisted label sets that
 *    round-trip (and fail closed), the content-free audit;
 *  - criterion 19: a fresh agent starts in context-memory mode `members`,
 *    an existing one keeps its mode.
 * Every migration is applied twice, like the CI schema job.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from '../_helpers/pgTestDb.js';

import { ConfigStore } from '../../packages/harness-orchestrator/src/registry/configStore.js';
import { runMultiOrchestratorMigrations } from '../../packages/harness-orchestrator/src/registry/migrator.js';
import { readersOf, unionLabels, EVERYONE } from '../../packages/harness-orchestrator/src/discretion/labels.js';
import { ConsultationStore } from '../../src/consultation/consultationStore.js';
import { DiscretionStore } from '../../src/discretion/discretionStore.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'consultation',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const SCHEMA = `consultation_${String(process.pid)}`;

describe('consultation and discretion stores (pg, migrations 0097–0099)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let config: ConfigStore;
  let consultation: ConsultationStore;
  let discretion: DiscretionStore;
  const ids: Record<string, string> = {};

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 3, options: `-c search_path=${SCHEMA},public` });
    // An agent that exists before 0099 keeps its mode.
    await runMultiOrchestratorMigrations(pool, () => undefined, MIGRATIONS_DIR);
    for (const file of ['0097_agent_consultation.sql', '0098_discretion.sql', '0099_context_memory_default_members.sql']) {
      await pool.query(await readFile(resolve(MIGRATIONS_DIR, file), 'utf8'));
    }
    config = new ConfigStore(pool);
    consultation = new ConsultationStore(() => pool);
    discretion = new DiscretionStore(pool);
    for (const slug of ['anna', 'ben', 'carl']) {
      ids[slug] = (await config.createAgent({ slug, name: slug.toUpperCase() })).id;
    }
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it('criterion 19: a fresh agent starts in `members`', async () => {
    const fresh = await config.getAgentBySlug('anna');
    assert.equal(fresh?.contextMemory, 'members');
    const { rows } = await pool.query<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'agents' AND column_name = 'context_memory'`,
      [SCHEMA],
    );
    assert.match(rows[0]!.column_default, /members/);
  });

  it('switches default off and are written per agent', async () => {
    assert.deepEqual(await consultation.getSwitches(ids['anna']!), { consultable: false, mayConsult: false });
    assert.deepEqual(await consultation.setSwitches(ids['anna']!, { mayConsult: true }), {
      consultable: false,
      mayConsult: true,
    });
    assert.deepEqual(await consultation.setSwitches(ids['anna']!, { consultable: true }), {
      consultable: true,
      mayConsult: true,
    });
  });

  it('a directed grant defaults to nothing, can be narrowed and is revoked by delete', async () => {
    const { before: none, after: grant } = await consultation.upsertGrant(ids['anna']!, ids['ben']!, {}, 'op@example.test');
    assert.equal(none, undefined);
    assert.deepEqual(
      [grant.channelScope, grant.allowedCapabilities, grant.memoryAccess, grant.disclosure, grant.maxCallsPerTurn, grant.maxCallsPerDay],
      [null, [], 'none', {}, 2, 50],
    );
    const { after: narrowed } = await consultation.upsertGrant(
      ids['anna']!,
      ids['ben']!,
      { channelScope: ['teams'], allowedCapabilities: ['@omadia/crm'], memoryAccess: 'discreet', disclosure: { context: 'existence' } },
      'op2@example.test',
    );
    assert.deepEqual(narrowed.channelScope, ['teams']);
    assert.deepEqual(narrowed.disclosure, { context: 'existence' });
    assert.equal(narrowed.updatedBy, 'op2@example.test');
    // A later partial update leaves the channel scope alone.
    const { after: kept } = await consultation.upsertGrant(ids['anna']!, ids['ben']!, { maxCallsPerDay: 5 }, 'op');
    assert.deepEqual(kept.channelScope, ['teams']);
    assert.equal(kept.maxCallsPerDay, 5);
    // Self-grants and out-of-range budgets are refused by the schema.
    await assert.rejects(consultation.upsertGrant(ids['anna']!, ids['anna']!, {}, 'op'));
    await assert.rejects(consultation.upsertGrant(ids['anna']!, ids['carl']!, { maxCallsPerTurn: 99 }, 'op'));
    assert.ok(await consultation.deleteGrant(ids['anna']!, ids['ben']!));
    assert.equal(await consultation.getGrant(ids['anna']!, ids['ben']!), undefined);
  });

  it('active pairs need the grant and both switches; a discussion needs both directions', async () => {
    await consultation.upsertGrant(ids['anna']!, ids['ben']!, {}, 'op');
    assert.deepEqual(await consultation.listActivePairs(), []);
    await consultation.setSwitches(ids['ben']!, { consultable: true });
    assert.deepEqual(await consultation.listActivePairs(), [{ fromSlug: 'anna', toSlug: 'ben' }]);
    assert.equal(await consultation.hasMutualGrants(ids['anna']!, ids['ben']!, 'teams'), false);
    await consultation.upsertGrant(ids['ben']!, ids['anna']!, {}, 'op');
    assert.equal(await consultation.hasMutualGrants(ids['anna']!, ids['ben']!, 'teams'), false, 'ben may not consult yet');
    await consultation.setSwitches(ids['ben']!, { mayConsult: true });
    assert.equal(await consultation.hasMutualGrants(ids['ben']!, ids['anna']!, 'teams'), true);
    // A grant scoped to Teams does not allow a discussion on Slack.
    await consultation.upsertGrant(ids['ben']!, ids['anna']!, { channelScope: ['teams'] }, 'op');
    assert.equal(await consultation.hasMutualGrants(ids['ben']!, ids['anna']!, 'slack'), false);
    assert.equal(await consultation.hasMutualGrants(ids['ben']!, ids['anna']!, 'teams'), true);
  });

  it('the call ledger links both turns and counts the day', async () => {
    assert.equal(await consultation.countCallsToday(ids['anna']!, ids['ben']!), 0);
    const id = '6a1f1c8e-0000-4000-8000-000000000001';
    const call = { fromAgentId: ids['anna']!, toAgentId: ids['ben']!, fromTurnId: 'turn-a', channelType: 'teams' };
    assert.equal(await consultation.startCall({ id, ...call, maxCallsPerDay: 2 }), true);
    await consultation.finishCall(id, { status: 'delivered', outcome: 'full', toTurnId: 'turn-b' });
    assert.equal(await consultation.countCallsToday(ids['anna']!, ids['ben']!), 1);
    const { rows } = await pool.query('SELECT from_turn_id, to_turn_id, status, outcome FROM agent_consultation_calls WHERE id = $1', [id]);
    assert.deepEqual(rows[0], { from_turn_id: 'turn-a', to_turn_id: 'turn-b', status: 'delivered', outcome: 'full' });
  });

  it('the day budget holds under concurrent calls', async () => {
    const call = { fromAgentId: ids['carl']!, toAgentId: ids['ben']!, fromTurnId: 'turn-c' };
    const started = await Promise.all(
      [2, 3, 4, 5, 6].map((n) =>
        consultation.startCall({ id: `6a1f1c8e-0000-4000-8000-00000000000${String(n)}`, ...call, maxCallsPerDay: 2 }),
      ),
    );
    assert.equal(started.filter(Boolean).length, 2);
    assert.equal(await consultation.countCallsToday(ids['carl']!, ids['ben']!), 2);
  });

  it('a deleted agent drops out of every pair', async () => {
    await pool.query(`UPDATE agents SET deleted_at = now(), deleted_by = 'op' WHERE id = $1`, [ids['ben']]);
    assert.deepEqual(await consultation.listActivePairs(), []);
    assert.equal(await consultation.getSwitches(ids['ben']!), undefined);
  });

  it('integration declarations round-trip and the snapshot follows writes', async () => {
    assert.equal(await discretion.declarationOf('@omadia/crm'), undefined);
    await discretion.upsertReadership(
      '@omadia/crm',
      { sensitivity: 'internal', readers: EVERYONE, acceptsSystems: ['@omadia/crm'], acceptsClassifications: [] },
      'op',
    );
    await discretion.upsertReadership(
      '@omadia/odoo-hr',
      { sensitivity: 'restricted', readers: readersOf(['hr-2', 'hr-1']), acceptsSystems: [], acceptsClassifications: ['personal'] },
      'op',
    );
    const hr = await discretion.declarationOf('@omadia/odoo-hr');
    assert.deepEqual(hr, {
      sensitivity: 'restricted',
      readership: { readers: { kind: 'set', ids: ['hr-1', 'hr-2'] }, acceptsSystems: [], acceptsClassifications: ['personal'] },
    });
    assert.ok(await discretion.deleteReadership('@omadia/odoo-hr'));
    assert.equal(await discretion.declarationOf('@omadia/odoo-hr'), undefined);
  });

  it('criterion 27: a written turn keeps its labels; a damaged row fails closed', async () => {
    const labels = unionLabels([
      { kind: 'context', key: 'teams:dm-hr', readers: readersOf(['hr-1']) },
      { kind: 'source', system: '@omadia/odoo-hr', restricted: true },
    ]);
    await discretion.persistLabels('turn', 'turn-1', 'anna', labels);
    await pool.query(
      `INSERT INTO discretion_labels (subject_kind, subject_id, labels) VALUES ('turn', 'turn-bad', '[{"kind":"weird"}]')`,
    );
    const found = await discretion.labelsOf('turn', ['turn-1', 'turn-bad', 'turn-missing']);
    assert.deepEqual(found.get('turn-1'), labels);
    assert.deepEqual(found.get('turn-bad')?.labels, [{ kind: 'context', key: 'unreadable', readers: { kind: 'unknown' } }]);
    assert.equal(found.has('turn-missing'), false);
  });

  it('the audit stores label ids and reasons only', async () => {
    discretion.audit({
      turnId: 't-1',
      agentSlug: 'anna',
      egress: 'integration',
      target: '@omadia/crm',
      allowed: false,
      labels: ['source:@omadia/odoo-hr'],
      violations: ['source:@omadia/odoo-hr:integration_readership'],
    });
    // Fire-and-forget: poll briefly.
    let rows: unknown[] = [];
    for (let i = 0; i < 20 && rows.length === 0; i += 1) {
      rows = (await pool.query('SELECT egress, target, allowed, labels, violations FROM discretion_flow_audit')).rows;
      if (rows.length === 0) await new Promise((r) => setTimeout(r, 25));
    }
    assert.deepEqual(rows, [
      {
        egress: 'integration',
        target: '@omadia/crm',
        allowed: false,
        labels: ['source:@omadia/odoo-hr'],
        violations: ['source:@omadia/odoo-hr:integration_readership'],
      },
    ]);
  });
});
