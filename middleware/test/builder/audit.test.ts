import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { createAuditLogger, noopAuditLogger } from '../../src/plugins/builder/audit.js';
import { DraftStore } from '../../src/plugins/builder/draftStore.js';

/**
 * Issue #56 — audit-log backend tests.
 *
 * Coverage:
 *   - DraftStore v2 schema migration (user_version=2, builder_audit table exists)
 *   - Mid-flight v1 → v2 upgrade keeps existing drafts intact
 *   - createAuditLogger.log writes a row with correct columns
 *   - listAudit returns newest-first paginated events with `total`
 *   - Fire-and-forget: log against broken store swallows the error
 *   - noopAuditLogger is a valid AuditLogger instance
 */

describe('audit log — DraftStore v2 migration (issue #56)', () => {
  let tmpRoot: string;
  let dbPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'audit-migration-'));
    dbPath = path.join(tmpRoot, 'drafts.db');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('fresh DB initialises at user_version=2 with both tables', async () => {
    const store = new DraftStore({ dbPath });
    await store.open();
    const db = new Database(dbPath);
    try {
      const version = db.pragma('user_version', { simple: true }) as number;
      assert.equal(version, 2);
      // both tables exist
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      assert.ok(tables.includes('drafts'), 'drafts table missing');
      assert.ok(tables.includes('builder_audit'), 'builder_audit table missing');
    } finally {
      db.close();
      await store.close();
    }
  });

  it('mid-flight v1 → v2 upgrade keeps existing drafts intact and adds the audit table', async () => {
    // Seed a v1 DB by hand: drafts table + a row + user_version=1.
    const db = new Database(dbPath);
    db.exec(`
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
    db.prepare(
      `INSERT INTO drafts (id, user_email, name, spec_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('legacy-draft', 'alice@example.com', 'Legacy', '{"template":"agent-integration"}', 1000, 1000);
    db.pragma('user_version = 1');
    db.close();

    // Open via DraftStore — migration to v2 should run.
    const store = new DraftStore({ dbPath });
    await store.open();
    const post = new Database(dbPath);
    try {
      assert.equal(post.pragma('user_version', { simple: true }) as number, 2);
      const draft = post
        .prepare("SELECT id, name FROM drafts WHERE id = 'legacy-draft'")
        .get() as { id: string; name: string };
      assert.equal(draft.id, 'legacy-draft');
      assert.equal(draft.name, 'Legacy');
      // audit table now exists + is empty for the legacy draft
      const auditCount = (
        post.prepare('SELECT COUNT(*) as n FROM builder_audit').get() as {
          n: number;
        }
      ).n;
      assert.equal(auditCount, 0);
    } finally {
      post.close();
      await store.close();
    }
  });
});

describe('audit log — appendAudit + listAudit (issue #56)', () => {
  let tmpRoot: string;
  let store: DraftStore;
  let draftId: string;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'audit-rw-'));
    store = new DraftStore({ dbPath: path.join(tmpRoot, 'drafts.db') });
    await store.open();
    const d = await store.create('alice@example.com', 'Weather');
    draftId = d.id;
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes a row visible via listAudit', async () => {
    const logger = createAuditLogger(store);
    await logger.log(draftId, 'alice@example.com', 'persona_updated', {
      template: 'software-engineer',
    });

    const page = await store.listAudit('alice@example.com', draftId);
    assert.equal(page.total, 1);
    assert.equal(page.events.length, 1);
    const ev = page.events[0]!;
    assert.equal(ev.draftId, draftId);
    assert.equal(ev.userEmail, 'alice@example.com');
    assert.equal(ev.action, 'persona_updated');
    assert.deepEqual(ev.details, { template: 'software-engineer' });
    assert.ok(typeof ev.createdAt === 'number' && ev.createdAt > 0);
  });

  it('listAudit returns newest-first', async () => {
    const logger = createAuditLogger(store);
    await logger.log(draftId, 'alice@example.com', 'persona_updated', { n: 1 });
    await logger.log(draftId, 'alice@example.com', 'quality_updated', { n: 2 });
    await logger.log(draftId, 'alice@example.com', 'spec_patched', { n: 3 });

    const page = await store.listAudit('alice@example.com', draftId);
    assert.equal(page.total, 3);
    assert.deepEqual(
      page.events.map((e) => e.action),
      ['spec_patched', 'quality_updated', 'persona_updated'],
    );
  });

  it('listAudit paginates with limit + offset', async () => {
    const logger = createAuditLogger(store);
    for (let i = 0; i < 5; i++) {
      await logger.log(draftId, 'alice@example.com', 'spec_patched', { n: i });
    }

    const first = await store.listAudit('alice@example.com', draftId, { limit: 2, offset: 0 });
    const second = await store.listAudit('alice@example.com', draftId, { limit: 2, offset: 2 });
    assert.equal(first.total, 5);
    assert.equal(first.events.length, 2);
    assert.equal(second.events.length, 2);
    assert.notDeepEqual(
      first.events.map((e) => e.id),
      second.events.map((e) => e.id),
      'first and second pages must be disjoint',
    );
  });

  it('owner-scoped: a different user sees an empty page', async () => {
    const logger = createAuditLogger(store);
    await logger.log(draftId, 'alice@example.com', 'persona_updated', {});
    const otherPage = await store.listAudit('bob@example.com', draftId);
    assert.equal(otherPage.total, 0);
    assert.equal(otherPage.events.length, 0);
  });
});

describe('audit log — resilience (issue #56)', () => {
  it('fire-and-forget: appendAudit failure does not throw out of logger', async () => {
    // Build a logger backed by an unopened store so appendAudit throws
    // ("DraftStore.open() must be called before use"). The logger should
    // catch and resolve silently.
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'audit-broken-'));
    const store = new DraftStore({ dbPath: path.join(tmpRoot, 'drafts.db') });
    // intentionally not opened
    const logger = createAuditLogger(store);
    await logger.log('any', 'any@example.com', 'persona_updated', {});
    // If we got here without throwing, the fire-and-forget contract holds.
    assert.ok(true);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('noopAuditLogger satisfies the AuditLogger contract', async () => {
    await noopAuditLogger.log('any', 'any@example.com', 'persona_updated', {});
    assert.ok(true);
  });
});
