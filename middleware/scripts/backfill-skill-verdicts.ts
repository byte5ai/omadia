import 'dotenv/config';
import { AgentGraphStore, computeSkillHash } from '@omadia/orchestrator';
import { Pool } from 'pg';

import {
  CURRENT_VERIFIER_VERSION,
  getOrComputeVerdict,
  type SkillVerdictStore,
} from '../src/services/skillVerdict.js';

function log(msg: string): void {
  console.log(msg);
}

async function main(): Promise<void> {
  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) throw new Error('DATABASE_URL required');

  log(`[skill-verdict-backfill] mode=APPLY verifier=${CURRENT_VERIFIER_VERSION}`);

  const pool = new Pool({ connectionString: dbUrl, max: 2 });
  const graph = new AgentGraphStore(pool);
  const verdictStore: SkillVerdictStore = {
    getVerdict: (contentHash, verifierVersion) =>
      graph.getSkillVerdict(contentHash, verifierVersion),
    upsertVerdict: (row) => graph.upsertSkillVerdict(row),
    getAck: (contentHash, verifierVersion) =>
      graph.getSkillVerdictAck(contentHash, verifierVersion),
    upsertAck: (contentHash, verifierVersion, ackedBy) =>
      graph
        .upsertSkillVerdictAck(contentHash, verifierVersion, ackedBy)
        .then(() => undefined),
  };

  try {
    const skills = await graph.listSkills();
    log(`[skill-verdict-backfill] found ${String(skills.length)} skill(s)`);

    let hashesBackfilled = 0;
    let verdictsComputed = 0;

    for (const skill of skills) {
      let contentHash = skill.contentHash;
      if (contentHash === null) {
        const expectedHash = computeSkillHash(skill.frontmatter, skill.body);
        const updated = await graph.updateSkill(skill.id, {});
        contentHash = updated.contentHash;
        if (contentHash !== expectedHash) {
          throw new Error(
            `content_hash mismatch after updateSkill for skill ${skill.id}: expected ${expectedHash}, got ${String(contentHash)}`,
          );
        }
        hashesBackfilled++;
        log(`[skill-verdict-backfill] backfilled content_hash for ${skill.slug} (${skill.id})`);
      }

      if (contentHash === null) {
        log(`[skill-verdict-backfill] skip ${skill.slug} (${skill.id}) — content_hash still null`);
        continue;
      }

      const existing = await graph.getSkillVerdict(contentHash, CURRENT_VERIFIER_VERSION);
      if (existing) continue;

      // `shouldRunVerifier` is for bursty in-memory online dedupe, not for an
      // idempotent offline backfill that must process every still-missing row.
      await getOrComputeVerdict(
        verdictStore,
        contentHash,
        skill.frontmatter,
        skill.body,
      );
      verdictsComputed++;
      log(
        `[skill-verdict-backfill] computed verdict for ${skill.slug} (${skill.id}) hash=${contentHash}`,
      );
    }

    log(
      `[skill-verdict-backfill] done: scanned=${String(skills.length)} hashesBackfilled=${String(hashesBackfilled)} verdictsComputed=${String(verdictsComputed)}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(
    '[skill-verdict-backfill] FAILED:',
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
