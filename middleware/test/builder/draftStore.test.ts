import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';

describe('DraftStore', () => {
  let tmp: string;
  let dbPath: string;
  let store: DraftStore;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'draft-store-test-'));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (store) await store.close();
    dbPath = join(tmp, `drafts-${String(Date.now())}-${String(Math.random())}.db`);
    store = new DraftStore({ dbPath });
    await store.open();
  });

  it('creates a draft with default skeleton + default model', async () => {
    const draft = await store.create('alice@example.com', 'My Weather Agent');
    assert.equal(draft.name, 'My Weather Agent');
    assert.equal(draft.userEmail, 'alice@example.com');
    assert.equal(draft.status, 'draft');
    // 2026-05-06: codegen-default ist Opus 4.7, preview-default Sonnet 4.6
    // (Cost-Split — siehe modelRegistry.ts).
    assert.equal(draft.codegenModel, 'opus');
    assert.equal(draft.previewModel, 'sonnet');
    assert.equal(draft.publishedAgentId, null);
    assert.deepEqual(draft.transcript, []);
    assert.deepEqual(draft.previewTranscript, []);
    assert.equal(draft.spec.version, '0.1.0');
  });

  it('falls back to "Neuer Agent" on blank names', async () => {
    const a = await store.create('alice@example.com', '');
    const b = await store.create('alice@example.com', '   ');
    assert.equal(a.name, 'Neuer Agent');
    assert.equal(b.name, 'Neuer Agent');
  });

  it('isolates drafts between users', async () => {
    const alice = await store.create('alice@example.com', 'A');
    const bob = await store.create('bob@example.com', 'B');

    assert.equal(
      await store.load('bob@example.com', alice.id),
      null,
      'bob must not read alice',
    );
    assert.equal(
      await store.load('alice@example.com', bob.id),
      null,
      'alice must not read bob',
    );

    const aliceList = await store.list('alice@example.com');
    assert.equal(aliceList.length, 1);
    assert.equal(aliceList[0]?.id, alice.id);
  });

  it('updates only provided fields and bumps updated_at', async () => {
    const draft = await store.create('a@x', 'Initial');
    const createdAt = draft.updatedAt;
    await new Promise((r) => setTimeout(r, 5));

    const patched = await store.update('a@x', draft.id, {
      name: 'Renamed',
      codegenModel: 'opus',
    });
    assert.ok(patched, 'patched draft should be returned');
    assert.equal(patched.name, 'Renamed');
    assert.equal(patched.codegenModel, 'opus');
    assert.equal(patched.previewModel, 'sonnet', 'untouched field stays');
    assert.ok(
      patched.updatedAt > createdAt,
      'updatedAt must advance on mutation',
    );
  });

  it('soft-delete hides drafts from list + load, restore brings them back', async () => {
    const draft = await store.create('a@x', 'Soft');
    const ok = await store.softDelete('a@x', draft.id);
    assert.equal(ok, true);

    assert.equal(await store.load('a@x', draft.id), null);
    assert.equal((await store.list('a@x')).length, 0);

    const deletedList = await store.list('a@x', { scope: 'deleted' });
    assert.equal(deletedList.length, 1);
    assert.equal(deletedList[0]?.id, draft.id);

    const restored = await store.restore('a@x', draft.id);
    assert.equal(restored, true);
    assert.ok(await store.load('a@x', draft.id));
  });

  it('update fails for soft-deleted drafts', async () => {
    const draft = await store.create('a@x', 'Soft');
    await store.softDelete('a@x', draft.id);
    const result = await store.update('a@x', draft.id, { name: 'Nope' });
    assert.equal(result, null);
  });

  it('count reflects active-only by default', async () => {
    await store.create('a@x', 'One');
    const two = await store.create('a@x', 'Two');
    await store.create('a@x', 'Three');
    await store.softDelete('a@x', two.id);

    assert.equal(await store.count('a@x'), 2);
    assert.equal(await store.count('a@x', { scope: 'all' }), 3);
  });

  it('list filter by status returns only matches', async () => {
    const a = await store.create('a@x', 'A');
    const b = await store.create('a@x', 'B');
    await store.update('a@x', a.id, {
      status: 'published',
      publishedAgentId: 'de.byte5.agent.weather',
    });

    const published = await store.list('a@x', { status: 'published' });
    assert.equal(published.length, 1);
    assert.equal(published[0]?.id, a.id);
    assert.equal(published[0]?.publishedAgentId, 'de.byte5.agent.weather');

    const drafts = await store.list('a@x', { status: 'draft' });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]?.id, b.id);
  });

  it('persists across open/close cycles', async () => {
    const draft = await store.create('a@x', 'Persisted');
    await store.close();

    const store2 = new DraftStore({ dbPath });
    await store2.open();
    const reloaded = await store2.load('a@x', draft.id);
    assert.ok(reloaded);
    assert.equal(reloaded.name, 'Persisted');
    await store2.close();

    store = new DraftStore({ dbPath });
    await store.open();
  });

  it('purgePublished hard-deletes soft-deleted published drafts past grace', async () => {
    const storeShort = new DraftStore({
      dbPath: join(tmp, `purge-${String(Date.now())}.db`),
      publishedPurgeGraceMs: 50,
    });
    await storeShort.open();

    const published = await storeShort.create('a@x', 'pub');
    const draftRow = await storeShort.create('a@x', 'plain');
    await storeShort.update('a@x', published.id, {
      status: 'published',
      publishedAgentId: 'de.byte5.agent.x',
    });

    await storeShort.softDelete('a@x', published.id);
    await storeShort.softDelete('a@x', draftRow.id);

    // Under grace — nothing should purge
    const earlyCount = await storeShort.purgePublished();
    assert.equal(earlyCount, 0);

    await new Promise((r) => setTimeout(r, 80));

    const purged = await storeShort.purgePublished();
    assert.equal(purged, 1, 'exactly the published+soft-deleted one purges');

    // Plain draft still there (never published → never auto-purged)
    const leftover = await storeShort.list('a@x', { scope: 'deleted' });
    assert.equal(leftover.length, 1);
    assert.equal(leftover[0]?.id, draftRow.id);

    await storeShort.close();
  });

  it('findByPublishedAgentId returns the most recent matching active draft', async () => {
    const a = await store.create('alice@example.com', 'A');
    const b = await store.create('alice@example.com', 'B');
    await store.update('alice@example.com', a.id, {
      status: 'published',
      publishedAgentId: 'de.byte5.agent.foo',
    });
    // Same agent_id pinned to a SECOND draft (Edit-from-Store re-publish
    // with a version bump produces this). updated_at on `b` is later, so
    // findByPublishedAgentId should return `b`.
    await new Promise((r) => setTimeout(r, 5));
    await store.update('alice@example.com', b.id, {
      status: 'published',
      publishedAgentId: 'de.byte5.agent.foo',
    });

    const hit = await store.findByPublishedAgentId(
      'alice@example.com',
      'de.byte5.agent.foo',
    );
    assert.ok(hit, 'expected a hit');
    assert.equal(hit.id, b.id, 'expected the most-recent draft');
    assert.equal(hit.publishedAgentId, 'de.byte5.agent.foo');
  });

  it('findByPublishedAgentId returns null for foreign user (owner-scoped)', async () => {
    const draft = await store.create('alice@example.com', 'A');
    await store.update('alice@example.com', draft.id, {
      status: 'published',
      publishedAgentId: 'de.byte5.agent.foo',
    });
    const hit = await store.findByPublishedAgentId(
      'attacker@example.com',
      'de.byte5.agent.foo',
    );
    assert.equal(hit, null);
  });

  it('findByPublishedAgentId skips soft-deleted source drafts', async () => {
    const draft = await store.create('alice@example.com', 'A');
    await store.update('alice@example.com', draft.id, {
      status: 'published',
      publishedAgentId: 'de.byte5.agent.foo',
    });
    await store.softDelete('alice@example.com', draft.id);
    const hit = await store.findByPublishedAgentId(
      'alice@example.com',
      'de.byte5.agent.foo',
    );
    assert.equal(hit, null);
  });

  it('normalizes missing skeleton arrays on load (regression: install-diff crash)', async () => {
    // Reproduces the GEO-Analyst draft state where patch_spec landed a spec
    // payload without `setup_fields` (and friends). InstallDiffModal used to
    // crash on `spec.setup_fields.length`; the store now guarantees the
    // arrays exist so every UI consumer can rely on them.
    const draft = await store.create('a@x', 'NoArrays');
    const corrupted = {
      id: 'de.byte5.agent.no-arrays',
      name: 'NoArrays',
      version: '0.1.0',
      description: 'd',
      category: 'other',
      skill: { role: 'r' },
      // intentionally missing: depends_on, tools, setup_fields,
      // network, playbook, external_reads, ui_routes
      slots: {},
    } as unknown as Parameters<typeof store.update>[2]['spec'];
    const patched = await store.update('a@x', draft.id, { spec: corrupted });
    assert.ok(patched, 'patched draft should be returned');
    assert.deepEqual(patched.spec.depends_on, []);
    assert.deepEqual(patched.spec.tools, []);
    assert.deepEqual(patched.spec.setup_fields, []);
    assert.deepEqual(patched.spec.network.outbound, []);
    assert.deepEqual(patched.spec.playbook.not_for, []);
    assert.deepEqual(patched.spec.playbook.example_prompts, []);

    // Re-load through a fresh connection to also exercise the read-path
    // normalizer (independent of the write-path normalizer above).
    await store.close();
    const store2 = new DraftStore({ dbPath });
    await store2.open();
    const reloaded = await store2.load('a@x', draft.id);
    assert.ok(reloaded);
    assert.deepEqual(reloaded.spec.setup_fields, []);
    assert.deepEqual(reloaded.spec.network.outbound, []);
    await store2.close();
    store = new DraftStore({ dbPath });
    await store.open();
  });

  it('findByPublishedAgentId returns null when no draft has been published', async () => {
    await store.create('alice@example.com', 'A');
    const hit = await store.findByPublishedAgentId(
      'alice@example.com',
      'de.byte5.agent.never-published',
    );
    assert.equal(hit, null);
  });

  it('schema is at user_version >= 2 after open', () => {
    const raw = new Database(dbPath);
    try {
      const version = raw.pragma('user_version', { simple: true }) as number;
      assert.ok(
        version >= 2,
        `expected user_version >= 2, got ${String(version)}`,
      );
    } finally {
      raw.close();
    }
  });

  it('v2 schema exposes the issue-reporting + workaround tables', () => {
    const raw = new Database(dbPath);
    try {
      const tables = (raw
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN
            ('github_issue_cache','agent_workaround_state','builder_triage_log')`,
        )
        .all() as Array<{ name: string }>).map((r) => r.name)
        .sort();
      assert.deepEqual(tables, [
        'agent_workaround_state',
        'builder_triage_log',
        'github_issue_cache',
      ]);
    } finally {
      raw.close();
    }
  });

  it('migrates v1 DBs to v2 without touching v1 data', async () => {
    const legacyPath = join(tmp, `legacy-${String(Date.now())}.db`);
    // Hand-craft a v1 DB: schema-version 1 + one drafts row.
    const seed = new Database(legacyPath);
    seed.exec(`
      CREATE TABLE drafts (
        id TEXT PRIMARY KEY,
        user_email TEXT NOT NULL,
        name TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        slots_json TEXT NOT NULL DEFAULT '{}',
        transcript_json TEXT NOT NULL DEFAULT '[]',
        preview_transcript_json TEXT NOT NULL DEFAULT '[]',
        codegen_model TEXT NOT NULL DEFAULT 'sonnet',
        preview_model TEXT NOT NULL DEFAULT 'sonnet',
        status TEXT NOT NULL DEFAULT 'draft',
        installed_agent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
    `);
    const now = Date.now();
    seed
      .prepare(
        `INSERT INTO drafts (id,user_email,name,spec_json,created_at,updated_at)
         VALUES ('legacy-1','legacy@example.com','Legacy',?,?,?)`,
      )
      .run(JSON.stringify({ version: '0.1.0', id: 'legacy.agent' }), now, now);
    seed.pragma('user_version = 1');
    seed.close();

    const upgraded = new DraftStore({ dbPath: legacyPath });
    await upgraded.open();

    const raw = new Database(legacyPath);
    try {
      const version = raw.pragma('user_version', { simple: true }) as number;
      assert.equal(version, 2);
      const row = raw
        .prepare('SELECT name FROM drafts WHERE id = ?')
        .get('legacy-1') as { name: string } | undefined;
      assert.equal(row?.name, 'Legacy');
      const tables = (raw
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN
            ('github_issue_cache','agent_workaround_state','builder_triage_log')`,
        )
        .all() as Array<{ name: string }>).length;
      assert.equal(tables, 3);
    } finally {
      raw.close();
      await upgraded.close();
    }
  });

  it('refuses to open a DB whose schema is newer than supported', async () => {
    const futurePath = join(tmp, `future-${String(Date.now())}.db`);
    const seed = new Database(futurePath);
    seed.exec('CREATE TABLE drafts (id TEXT PRIMARY KEY);');
    seed.pragma('user_version = 999');
    seed.close();

    const future = new DraftStore({ dbPath: futurePath });
    await assert.rejects(() => future.open(), /newer than this middleware supports/);
  });
});

describe('DraftStore v1 → v3 migration (2026-05-18)', () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'draft-store-v1v2-'));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('migrates installed → published, renames the column, bumps user_version, writes a backup', async () => {
    // Build a v1-shaped DB by hand — the legacy schema_v1 SQL the migration
    // expects to encounter on disk.
    const dbPath = join(tmp, `v1-${String(Date.now())}-${String(Math.random())}.db`);
    const v1 = new Database(dbPath);
    v1.exec(`
      CREATE TABLE drafts (
        id                      TEXT PRIMARY KEY,
        user_email              TEXT NOT NULL,
        name                    TEXT NOT NULL,
        spec_json               TEXT NOT NULL,
        slots_json              TEXT NOT NULL DEFAULT '{}',
        transcript_json         TEXT NOT NULL DEFAULT '[]',
        preview_transcript_json TEXT NOT NULL DEFAULT '[]',
        codegen_model           TEXT NOT NULL DEFAULT 'sonnet',
        preview_model           TEXT NOT NULL DEFAULT 'sonnet',
        status                  TEXT NOT NULL DEFAULT 'draft',
        installed_agent_id      TEXT,
        created_at              INTEGER NOT NULL,
        updated_at              INTEGER NOT NULL,
        deleted_at              INTEGER
      );
      CREATE INDEX idx_drafts_installed_purge ON drafts(status, deleted_at);
    `);
    v1.pragma('user_version = 1');
    const now = Date.now();
    v1.prepare(
      `INSERT INTO drafts (id, user_email, name, spec_json, status, installed_agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'd-installed-1',
      'alice@example.com',
      'Legacy installed draft',
      '{"id":"de.byte5.agent.legacy","version":"0.1.0"}',
      'installed',
      'de.byte5.agent.legacy',
      now,
      now,
    );
    v1.prepare(
      `INSERT INTO drafts (id, user_email, name, spec_json, status, installed_agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'd-draft-1',
      'alice@example.com',
      'Legacy plain draft',
      '{"id":"de.byte5.agent.wip","version":"0.0.1"}',
      'draft',
      null,
      now,
      now,
    );
    v1.close();

    // Migrate via the store.
    const store = new DraftStore({ dbPath });
    await store.open();
    await store.close();

    // Schema bump persisted.
    const inspect = new Database(dbPath);
    const version = inspect.pragma('user_version', { simple: true });
    assert.equal(version, 3);

    // Column renamed; legacy column gone.
    const cols = (
      inspect.prepare(`SELECT name FROM pragma_table_info('drafts')`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    assert.ok(cols.includes('published_agent_id'), 'published_agent_id should exist');
    assert.ok(!cols.includes('installed_agent_id'), 'installed_agent_id should be gone');

    // Data migrated: installed row is now 'published' with the agent id intact.
    const rows = inspect
      .prepare(`SELECT id, status, published_agent_id FROM drafts ORDER BY id`)
      .all() as Array<{ id: string; status: string; published_agent_id: string | null }>;
    inspect.close();

    assert.equal(rows.length, 2);
    const installedRow = rows.find((r) => r.id === 'd-installed-1');
    const draftRow = rows.find((r) => r.id === 'd-draft-1');
    assert.ok(installedRow);
    assert.equal(installedRow.status, 'published');
    assert.equal(installedRow.published_agent_id, 'de.byte5.agent.legacy');
    assert.ok(draftRow);
    assert.equal(draftRow.status, 'draft');
    assert.equal(draftRow.published_agent_id, null);

    // Online backup landed alongside the DB file.
    const backups = readdirSync(tmp).filter(
      (n) => n.startsWith(`${dbPath.split('/').pop()}.bak-v1-`),
    );
    assert.equal(backups.length, 1, 'exactly one v1 backup file should exist');
  });

  it('re-opening an already-migrated DB is a no-op (idempotent)', async () => {
    const dbPath = join(tmp, `v2-${String(Date.now())}-${String(Math.random())}.db`);
    const store1 = new DraftStore({ dbPath });
    await store1.open();
    const draft = await store1.create('alice@example.com', 'Fresh on v2');
    await store1.close();

    const store2 = new DraftStore({ dbPath });
    await store2.open();
    const reloaded = await store2.load('alice@example.com', draft.id);
    await store2.close();

    assert.ok(reloaded);
    assert.equal(reloaded.name, 'Fresh on v2');

    // No backup file should have been written on the second open.
    const backups = readdirSync(tmp).filter(
      (n) => n.startsWith(`${dbPath.split('/').pop()}.bak-v1-`),
    );
    assert.equal(backups.length, 0, 'no migration ⇒ no backup file');
  });

  it('refuses to open a DB with an unknown future schema version', async () => {
    const dbPath = join(tmp, `future-${String(Date.now())}.db`);
    const db = new Database(dbPath);
    db.exec(
      `CREATE TABLE drafts (id TEXT PRIMARY KEY, user_email TEXT, name TEXT,
       spec_json TEXT NOT NULL, slots_json TEXT NOT NULL DEFAULT '{}',
       transcript_json TEXT NOT NULL DEFAULT '[]',
       preview_transcript_json TEXT NOT NULL DEFAULT '[]',
       codegen_model TEXT, preview_model TEXT, status TEXT,
       published_agent_id TEXT, created_at INTEGER, updated_at INTEGER,
       deleted_at INTEGER);`,
    );
    db.pragma('user_version = 99');
    db.close();

    const store = new DraftStore({ dbPath });
    await assert.rejects(() => store.open(), /schema version 99/);
    assert.ok(existsSync(dbPath));
  });
});
