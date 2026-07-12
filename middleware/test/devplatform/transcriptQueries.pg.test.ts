import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { runMultiOrchestratorMigrations } from '@omadia/orchestrator';

import { DevJobStore } from '../../src/devplatform/devJobStore.js';
import { DevRepoStore } from '../../src/devplatform/devRepoStore.js';
import { mintRunnerToken } from '../../src/devplatform/jobToken.js';
import { redactSecrets } from '../../src/devplatform/policy/scanForSecrets.js';
import {
  exportJobArtifacts,
  listJobArtifacts,
  searchArtifacts,
} from '../../src/devplatform/transcriptQueries.js';
import type { DevJob, DevRepo } from '../../src/devplatform/types.js';

/**
 * Epic #470 W5 — DB-gated integration for the transcript-tooling unit (spec §10):
 * the `list` / `export` / `search` verbs of `scripts/dev-transcript.ts`, exercised
 * through their extracted query helpers. Skips when no test Postgres is reachable,
 * mirroring the other `*.pg.test.ts`.
 */
const PG_URL =
  process.env['GRAPH_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  process.env['WS5_PG_TEST_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://test:test@127.0.0.1:55438/test';

const MARK = 'pg-devplatform-transcript-test';
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

const probePool = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
let pgAvailable = true;
try {
  await probePool.query('SELECT 1');
} catch {
  pgAvailable = false;
  await probePool.end().catch(() => undefined);
}

describe('devplatform/transcriptQueries (pg)', { skip: !pgAvailable }, () => {
  const pool = probePool;
  const repoStore = new DevRepoStore(pool);
  const store = new DevJobStore(pool);
  let repo: DevRepo;

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM dev_repos WHERE created_by = $1', [MARK]);
  }

  async function newJob(): Promise<DevJob> {
    const { hash } = mintRunnerToken();
    return store.createJob({
      repoId: repo.id,
      kind: 'implement',
      brief: 'b',
      source: 'admin',
      backend: 'local',
      createdBy: MARK,
      runnerTokenHash: hash,
    });
  }

  before(async () => {
    await runMultiOrchestratorMigrations(pool, undefined, migrationsDir);
    await cleanup();
    repo = await repoStore.createRepo({
      owner: MARK,
      name: `r-${randomUUID().slice(0, 8)}`,
      cloneUrl: 'https://example.com/x/y.git',
      credentialKind: 'pat',
      credentialRef: 'repo/x',
      createdBy: MARK,
    });
  });

  after(async () => {
    await cleanup();
    await pool.end().catch(() => undefined);
  });

  it('list: returns a job artifacts with kind, byte size, and storage', async () => {
    const job = await newJob();
    const content = 'a small transcript — üñïçödé'; // multibyte: bytes > char count
    await store.addArtifact(job.id, 'analysis', content);
    await store.addArtifact(job.id, 'summary', 'short');

    const rows = await listJobArtifacts(pool, job.id);
    assert.equal(rows.length, 2, 'both artifacts listed');

    const analysis = rows.find((r) => r.kind === 'analysis');
    assert.ok(analysis, 'analysis artifact present');
    assert.equal(analysis.bytes, Buffer.byteLength(content, 'utf8'), 'byte size is octet_length');
    assert.ok(analysis.bytes > content.length, 'multibyte content: bytes exceed char count');
    assert.equal(analysis.stored, 'full', 'plain content classified full');
    assert.equal(analysis.jobId, job.id);
  });

  it('list: an unknown job yields no rows; a non-uuid throws', async () => {
    const rows = await listJobArtifacts(pool, randomUUID());
    assert.equal(rows.length, 0, 'no artifacts for an unknown job');
    await assert.rejects(() => listJobArtifacts(pool, 'not-a-uuid'), /invalid jobId/);
  });

  it('export: emits one parseable JSONL row per artifact', async () => {
    const job = await newJob();
    await store.addArtifact(job.id, 'plan', 'the plan body');
    await store.addArtifact(job.id, 'summary', 'the summary body');

    const rows = await exportJobArtifacts(pool, job.id, { redact: false });
    assert.equal(rows.length, 2);

    // Round-trip each through JSON.stringify → JSON.parse, as the CLI does.
    for (const r of rows) {
      const line = JSON.stringify(r);
      const parsed = JSON.parse(line) as { jobId: string; kind: string; content: string };
      assert.equal(parsed.jobId, job.id, 'jobId survives the JSONL round-trip');
      assert.ok(typeof parsed.content === 'string', 'content is a string');
    }
    const kinds = rows.map((r) => r.kind).sort();
    assert.deepEqual(kinds, ['plan', 'summary']);
  });

  it('export --redact: a planted ghp_ token never appears in the output', async () => {
    // Assemble the secret AT RUNTIME — no literal token in this source file.
    const secret = `ghp_${(randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 36)}`;
    const job = await newJob();
    await store.addArtifact(job.id, 'analysis', `logs before ${secret} logs after`);

    const plain = await exportJobArtifacts(pool, job.id, { redact: false });
    assert.ok(plain[0]?.content.includes(secret), 'sanity: the secret is present unredacted');

    const redacted = await exportJobArtifacts(pool, job.id, {
      redact: true,
      redactor: (t) => redactSecrets(t),
    });
    const joined = redacted.map((r) => JSON.stringify(r)).join('\n');
    assert.ok(!joined.includes(secret), 'the secret must NOT appear in redacted export');
    assert.ok(joined.includes('[REDACTED]'), 'the secret is replaced by a placeholder');
  });

  it('search: ILIKE finds by substring; --since excludes older rows', async () => {
    const job = await newJob();
    const needle = `needle-${randomUUID().slice(0, 8)}`;

    // Older artifact (created_at forced 10 days back) + a recent one, both matching.
    const oldId = await store.addArtifact(job.id, 'analysis', `old ${needle} content`);
    await pool.query(
      `UPDATE dev_job_artifacts SET created_at = now() - interval '10 days' WHERE id = $1`,
      [oldId],
    );
    await store.addArtifact(job.id, 'summary', `recent ${needle} content`);
    // A non-matching artifact must never surface.
    await store.addArtifact(job.id, 'plan', 'unrelated body');

    const all = await searchArtifacts(pool, needle);
    assert.equal(all.length, 2, 'both matching artifacts found by ILIKE substring');
    assert.ok(
      all.every((r) => r.content.includes(needle)),
      'every hit actually contains the needle',
    );

    const since = new Date(Date.now() - 2 * 86_400_000).toISOString(); // 2 days ago
    const recent = await searchArtifacts(pool, needle, { since });
    assert.equal(recent.length, 1, '--since excludes the 10-day-old row');
    assert.ok(!recent.some((r) => r.id === oldId), 'the old row is filtered out');

    await assert.rejects(() => searchArtifacts(pool, needle, { since: 'nonsense' }), /invalid --since/);
  });

  it('search: ILIKE metacharacters in the query are matched literally', async () => {
    const job = await newJob();
    const literal = `100%_done-${randomUUID().slice(0, 8)}`;
    await store.addArtifact(job.id, 'summary', `status: ${literal}`);
    // A row that would match if % were treated as a wildcard, but not literally.
    await store.addArtifact(job.id, 'summary', '100XYZdone');

    const hits = await searchArtifacts(pool, literal);
    assert.equal(hits.length, 1, 'only the literal-substring row matches');
    assert.ok(hits[0]?.content.includes(literal));
  });
});
