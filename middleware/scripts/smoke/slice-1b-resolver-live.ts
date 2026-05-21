/**
 * Live-DB exercise of `resolveOrCreateChannelIdentity` against the
 * worktree-local Postgres. Verifies the SQL paths (fast-path, hybrid
 * email merge, fresh cluster) — InMemory unit tests prove the same
 * semantics, this checks the actual SQL plan and column-name wiring.
 *
 * Safe to re-run: leaves a couple of ChannelIdentity + User nodes
 * behind. `docker compose down -v` resets the DB.
 */
import 'dotenv/config';

import { Pool } from 'pg';

import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url || !(url.includes('localhost') || url.includes('127.0.0.1'))) {
    console.error('refusing — DATABASE_URL must point at localhost');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url, max: 2 });
  const kg = new NeonKnowledgeGraph({ pool, tenantId: 'kg-local-smoke' });
  const failures: string[] = [];

  try {
    const teams = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'teams',
      channelUserId: 'aad-oid-smoke-1',
      displayName: 'Smoke Alice',
      email: 'smoke-alice@example.com',
      emailVerified: true,
    });
    if (!teams.isNewIdentity || !teams.isNewCluster) {
      failures.push(`teams identity should be new + new cluster, got ${JSON.stringify(teams)}`);
    }

    const teamsAgain = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'teams',
      channelUserId: 'aad-oid-smoke-1',
      email: 'smoke-alice@example.com',
      emailVerified: true,
    });
    if (teamsAgain.omadiaUserId !== teams.omadiaUserId) {
      failures.push('idempotency broke: second teams call produced different cluster');
    }
    if (teamsAgain.isNewIdentity || teamsAgain.isNewCluster) {
      failures.push('idempotency broke: second teams call reports isNew=true');
    }

    const slack = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'slack',
      channelUserId: 'U-smoke-2',
      email: 'smoke-alice@example.com',
      emailVerified: true,
    });
    if (slack.omadiaUserId !== teams.omadiaUserId) {
      failures.push('hybrid-merge broke: slack should join teams cluster on verified email match');
    }
    if (!slack.isNewIdentity || slack.isNewCluster) {
      failures.push('hybrid-merge wrong flags: expected isNewIdentity=true, isNewCluster=false');
    }

    const telegram = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'telegram',
      channelUserId: '5551112222',
    });
    if (telegram.omadiaUserId === teams.omadiaUserId) {
      failures.push('telegram (no email) should NOT join teams cluster');
    }
    if (!telegram.isNewCluster) {
      failures.push('telegram should produce fresh cluster');
    }

    console.log('clusters created (tenant=kg-local-smoke):');
    console.log(`  teams cluster:  ${teams.omadiaUserId}`);
    console.log(`  slack joined:   ${slack.omadiaUserId} (should equal teams)`);
    console.log(`  telegram:       ${telegram.omadiaUserId} (should differ)`);
  } finally {
    await pool.end();
  }

  if (failures.length > 0) {
    console.error('\n[slice-1b-resolver-live] FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n[slice-1b-resolver-live] all checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
