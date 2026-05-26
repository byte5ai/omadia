/**
 * Slice 1b-channel-web — integration smoke for the auth-deps
 * `resolveChannelIdentity` callback shape used in `src/index.ts`. Runs
 * against the worktree-local Postgres (DATABASE_URL must point at
 * localhost — refused otherwise as a foot-gun guard).
 *
 * Verifies:
 *   - A fresh local-provider user (no AAD) gets a cluster with
 *     emailVerified=false, displayName seeded.
 *   - A fresh entra-provider user gets a cluster with emailVerified=true.
 *   - The Slice 1b cross-channel hybrid-merge kicks in: same verified
 *     email through two different providers in the same tenant yields
 *     one cluster, two identities.
 *   - Idempotent re-call returns the same cluster.
 *
 * Cleans the smoke-tenant after itself.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon';

const TENANT = 'slice-1b-web-smoke';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url || !(url.includes('localhost') || url.includes('127.0.0.1'))) {
    console.error('refusing — DATABASE_URL must point at localhost');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url, max: 2 });
  const kg = new NeonKnowledgeGraph({ pool, tenantId: TENANT });
  const failures: string[] = [];

  // Mirror the inline callback wired in src/index.ts, but without the
  // userStore lookup (we pass usersRowId straight through as a uuid).
  const resolveChannelIdentity = async (input: {
    provider: string;
    providerUserId: string;
    email: string;
    displayName: string;
    /** Simulated users.id (post-userStore-lookup). */
    usersRowId: string;
  }): Promise<string> => {
    const isEntra = input.provider === 'entra';
    const result = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: input.usersRowId,
      displayName: input.displayName,
      email: input.email,
      emailVerified: isEntra,
      ...(isEntra ? { aadObjectId: input.providerUserId } : {}),
    });
    return result.omadiaUserId;
  };

  try {
    // Case 1: local-provider user (e.g. setup-wizard admin).
    const localRowId = randomUUID();
    const localOmadia = await resolveChannelIdentity({
      provider: 'local',
      providerUserId: 'admin@example.com',
      email: 'admin@example.com',
      displayName: 'Local Admin',
      usersRowId: localRowId,
    });
    const localCheck = await pool.query<{
      email: string;
      verified: string | null;
      display: string;
    }>(
      `SELECT
         properties->>'email' AS email,
         properties->>'emailVerified' AS verified,
         properties->>'displayName' AS display
       FROM graph_nodes
       WHERE tenant_id = $1 AND external_id = $2 AND type = 'ChannelIdentity'`,
      [TENANT, `web:${localRowId}`],
    );
    const localRow = localCheck.rows[0];
    if (!localRow) failures.push('local ChannelIdentity row missing');
    if (localRow?.verified !== 'false')
      failures.push(`local emailVerified should be 'false', got ${String(localRow?.verified)}`);
    if (localRow?.display !== 'Local Admin')
      failures.push(`local displayName mismatch: ${String(localRow?.display)}`);
    console.log(`[local]   cluster=${localOmadia} emailVerified=false ✓`);

    // Case 2: entra-provider user with same email — should HYBRID-MERGE
    // onto the local user's cluster? No: local was emailVerified=false,
    // so it's NOT a merge anchor. Entra spins up its own fresh cluster.
    const entraRowId = randomUUID();
    const entraOmadia = await resolveChannelIdentity({
      provider: 'entra',
      providerUserId: 'aad-oid-smoke-1',
      email: 'admin@example.com',
      displayName: 'AAD Admin',
      usersRowId: entraRowId,
    });
    if (entraOmadia === localOmadia) {
      failures.push('entra should NOT merge with local (local was emailVerified=false)');
    }

    // Verify aadObjectId is stored as a first-class prop on entra ID.
    const entraIdentityProps = await pool.query<{ aad: string | null }>(
      `SELECT properties->>'aadObjectId' AS aad
       FROM graph_nodes
       WHERE tenant_id = $1 AND external_id = $2 AND type = 'ChannelIdentity'`,
      [TENANT, `web:${entraRowId}`],
    );
    const aadStored = entraIdentityProps.rows[0]?.aad;
    if (aadStored !== 'aad-oid-smoke-1') {
      failures.push(
        `entra ChannelIdentity should carry aadObjectId='aad-oid-smoke-1', got ${String(aadStored)}`,
      );
    }
    // Local identity should NOT carry aadObjectId.
    const localIdentityProps = await pool.query<{ aad: string | null }>(
      `SELECT properties->>'aadObjectId' AS aad
       FROM graph_nodes
       WHERE tenant_id = $1 AND external_id = $2 AND type = 'ChannelIdentity'`,
      [TENANT, `web:${localRowId}`],
    );
    if (localIdentityProps.rows[0]?.aad != null) {
      failures.push(
        'local ChannelIdentity should NOT carry aadObjectId (only entra does)',
      );
    }
    console.log(`[entra-1] cluster=${entraOmadia} aadObjectId=${aadStored} ✓`);

    // Case 3: a SECOND entra-provider user with the same email — both
    // sides emailVerified=true, both in same tenant → should merge.
    const entra2RowId = randomUUID();
    const entra2Omadia = await resolveChannelIdentity({
      provider: 'entra',
      providerUserId: 'aad-oid-smoke-2',
      email: 'admin@example.com',
      displayName: 'AAD Admin 2',
      usersRowId: entra2RowId,
    });
    if (entra2Omadia !== entraOmadia) {
      failures.push(
        `entra-2 should join entra-1 cluster on verified email: got ${entra2Omadia} vs ${entraOmadia}`,
      );
    }
    console.log(`[entra-2] cluster=${entra2Omadia} (joined entra-1) ✓`);

    // Case 4: idempotency — re-call with entra-1 input → same cluster.
    const entra1Again = await resolveChannelIdentity({
      provider: 'entra',
      providerUserId: 'aad-oid-smoke-1',
      email: 'admin@example.com',
      displayName: 'AAD Admin',
      usersRowId: entraRowId,
    });
    if (entra1Again !== entraOmadia) {
      failures.push(`idempotency broken: ${entra1Again} vs ${entraOmadia}`);
    }
    console.log(`[idemp]   re-call → same cluster ✓`);

    // Case 5: AAD-oid cross-kind merge — simulate the future Teams
    // plugin landing the SAME AAD oid as the web identity. Teams writes
    // `channelKind='teams', channelUserId=<oid>, aadObjectId=<oid>`.
    // Resolver MUST merge onto entra-1's cluster via the AAD-oid match,
    // even without an email being supplied.
    const teamsResult = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'teams',
      channelUserId: 'aad-oid-smoke-1',
      displayName: 'AAD Admin (Teams)',
      aadObjectId: 'aad-oid-smoke-1',
      // no email — Teams plugin might or might not supply it.
    });
    if (teamsResult.omadiaUserId !== entraOmadia) {
      failures.push(
        `teams-style call with matching oid should join entra cluster: got ${teamsResult.omadiaUserId} vs ${entraOmadia}`,
      );
    }
    if (!teamsResult.isNewIdentity || teamsResult.isNewCluster) {
      failures.push(
        'teams-style call should be isNewIdentity=true + isNewCluster=false',
      );
    }
    console.log(`[teams]   cluster=${teamsResult.omadiaUserId} (joined via AAD-oid) ✓`);
  } finally {
    // Cleanup smoke tenant.
    await pool.query(`DELETE FROM graph_edges WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM graph_nodes WHERE tenant_id = $1`, [TENANT]);
    await pool.end();
  }

  if (failures.length > 0) {
    console.error('\n[slice-1b-web-resolver] FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n[slice-1b-web-resolver] all checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
