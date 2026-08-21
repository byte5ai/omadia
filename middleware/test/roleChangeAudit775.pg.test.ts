/**
 * #775 — the end-to-end proof at the layer where the bug actually lived.
 *
 * The defect was a DATABASE-level cast failure: an email in the uuid
 * `actor_id` column made every `conductor.role_holders_change` insert throw,
 * so the unit-level mapper tests alone cannot prove the fix — this suite runs
 * `roleChangeAuditEntry` output through the real `AdminAuditLog.record`
 * against the real `admin_audit` DDL (migration 0002, applied verbatim).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { AdminAuditLog, roleChangeAuditEntry } from '../src/auth/adminAuditLog.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'roleChangeAudit775',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The REAL DDL, not a copy: a hand-duplicated schema here could drift from
// the migration and green-light an entry the production table rejects —
// which is the exact failure class this suite exists to prevent.
const SCHEMA = readFileSync(
  path.join(HERE, '../src/auth/migrations/0002_admin_audit.sql'),
  'utf8',
);

describe('#775 role-holders audit against real Postgres', { skip: !pgAvailable }, () => {
  let pool: Pool;

  before(async () => {
    pool = new Pool({ connectionString: PG_URL });
    await pool.query('DROP TABLE IF EXISTS admin_audit');
    await pool.query(SCHEMA);
  });

  after(async () => {
    await pool.query('DROP TABLE IF EXISTS admin_audit');
    await pool.end();
  });

  it('an email-sub session lands a row (the exact case that used to throw)', async () => {
    const log = new AdminAuditLog(pool);

    await log.record(
      roleChangeAuditEntry({
        actor: 'demo@byte5.de',
        roleKey: 'release-approver',
        action: 'add',
        holderId: 'user:u-2',
        holdersAfter: ['user:u-1', 'user:u-2'],
      }),
    );

    const rows = await pool.query(
      "SELECT actor_id, actor_email, action, target FROM admin_audit WHERE action = 'conductor.role_holders_change'",
    );
    assert.equal(rows.rowCount, 1, 'the audit row must actually land');
    assert.equal(rows.rows[0].actor_id, null);
    assert.equal(rows.rows[0].actor_email, 'demo@byte5.de');
    assert.equal(rows.rows[0].target, 'conductor-role:release-approver');
  });

  it('the OLD mapping is rejected by the real column — the regression stays impossible to miss', async () => {
    // This is the mutation-check as a permanent test: anyone who reverts the
    // closure to `actor: { id: entry.actor }` reproduces exactly this insert,
    // and this asserts the database still refuses it.
    const log = new AdminAuditLog(pool);
    await assert.rejects(
      () =>
        log.record({
          actor: { id: 'demo@byte5.de' },
          action: 'conductor.role_holders_change',
          target: 'conductor-role:x',
        }),
      /invalid input syntax for type uuid/,
    );
  });
});
