/**
 * #914 — `agent_identities` store against a real Postgres.
 *
 * The schema is applied from the ACTUAL migration files (0001 for `agents`,
 * which 0052 references, then 0052 and 0053), each twice, so this suite
 * doubles as the
 * double-apply proof the migrations README demands and so the store and the
 * migration cannot drift apart silently: the accent-colour CHECK, the
 * revision CHECK, the cascade from `agents` and the one-row-per-agent primary
 * key are all exercised against the real constraints.
 *
 * The revision rules get the most attention here, because they are the ones
 * with a consequence outside the database: the revision is the Teams manifest
 * version, so a bump that does not happen means an edit Teams will refuse to
 * accept, and a bump that happens for nothing means a pointless re-publish.
 *
 * Runs in its own schema (search_path pinned per connection), mirroring
 * `agentTeamsIdentityStore.pg.test.ts`. Skips cleanly when no test Postgres
 * is reachable.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import {
  AgentIdentityStore,
  DEFAULT_AGENT_ACCENT_COLOR,
  resolveAgentIdentity,
} from '../src/platform/agentIdentityStore.js';
import type { OperatorAgentIdentityStore } from '../src/routes/operatorAgents.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'agentIdentityStore',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

const SCHEMA = `agent_identity_${String(process.pid)}`;

/**
 * A blank write — the shape a PUT sends when nothing is authored. The
 * compiled prompt travels with every save because the caller owns the
 * compilers; `null` is what an identity with nothing in it compiles to.
 */
const EMPTY = {
  displayName: null,
  shortDescription: null,
  longDescription: null,
  instructions: null,
  accentColor: null,
  persona: null,
  quality: null,
  composed: { text: null, family: null },
};

describe('AgentIdentityStore against a real Postgres (#914)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: AgentIdentityStore;
  let agentId: string;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({
      connectionString: PG_URL,
      max: 2,
      options: `-c search_path=${SCHEMA},public`,
    });
    // 0002 is not optional scenery: 0001 ships a notify trigger whose
    // payload expression (`NEW.agent_id`) does not exist on `agents`, so an
    // INSERT into the table this migration references fails until 0002
    // replaces the function. A suite that applied only 0001 would report a
    // broken fixture as a broken store.
    for (const file of [
      '0001_multi_orchestrator.sql',
      '0002_fix_notify_trigger.sql',
      '0052_agent_identities.sql',
      '0053_agent_identity_persona.sql',
      // #1033 W2 — `composed_prompts` (per-family prompt cache) lives on the
      // identity row; the store reads it in `META_COLUMNS`, so the suite
      // must carry the migration that adds it (and proves it double-applies).
      '0059_agent_model_policy.sql',
    ]) {
      const sql = await readFile(resolve(MIGRATIONS_DIR, file), 'utf8');
      // Twice: the schema CI gate double-applies every file in the series.
      await pool.query(sql);
      await pool.query(sql);
    }
    store = new AgentIdentityStore(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE agents CASCADE');
    const res = await pool.query<{ id: string }>(
      `INSERT INTO agents (slug, name, description) VALUES ('sales', 'Sales Agent', 'Sells') RETURNING id`,
    );
    agentId = (res.rows[0] as { id: string }).id;
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it('is a drop-in OperatorAgentIdentityStore for the operator router', () => {
    // Compile-time pin: the routes talk to the port, not to this class.
    const routerStore: OperatorAgentIdentityStore = store;
    assert.ok(routerStore);
  });

  it('reports no identity for an agent that never authored one', async () => {
    assert.equal(await store.getByAgentId(agentId), undefined);
  });

  it('creates the row on first save and starts the revision at 1', async () => {
    const saved = await store.save(agentId, {
      ...EMPTY,
      displayName: 'Vertrieb',
    });
    assert.equal(saved.displayName, 'Vertrieb');
    assert.equal(saved.revision, 1);
    assert.equal(saved.avatar, null);
  });

  it('bumps the revision when the text changes and leaves it when it does not', async () => {
    const first = await store.save(agentId, {
      ...EMPTY,
      displayName: 'Vertrieb',
    });
    const same = await store.save(agentId, {
      ...EMPTY,
      // Same content, differently whitespaced: the manifest would be
      // byte-identical, so re-publishing it would be pure waste.
      displayName: '  Vertrieb  ',
    });
    assert.equal(same.revision, first.revision);
    const changed = await store.save(agentId, {
      ...EMPTY,
      displayName: 'Vertrieb DACH',
    });
    assert.equal(changed.revision, first.revision + 1);
  });

  it('treats a blank string as "inherit", not as an empty name', async () => {
    await store.save(agentId, { ...EMPTY, displayName: 'Vertrieb' });
    const cleared = await store.save(agentId, { ...EMPTY, displayName: '   ' });
    assert.equal(cleared.displayName, null);
    const resolved = resolveAgentIdentity(cleared, {
      name: 'Sales Agent',
      description: 'Sells',
    });
    assert.equal(resolved.displayName, 'Sales Agent');
  });

  it('refuses an accent colour the Teams manifest would reject', async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO agent_identities (agent_id, accent_color) VALUES ($1, 'purple')`,
        [agentId],
      ),
      /agent_identities_accent_color_check/,
    );
    // The product default is a valid one, which is what the fallback ships.
    assert.match(DEFAULT_AGENT_ACCENT_COLOR, /^#[0-9A-Fa-f]{6}$/);
  });

  it('stores an avatar with its icons and hands the icons back for provisioning', async () => {
    const saved = await store.setAvatar(agentId, {
      original: new Uint8Array([1, 2, 3]),
      color: new Uint8Array([4, 5]),
      outline: new Uint8Array([6]),
      etag: 'abc123',
    });
    assert.deepEqual(saved.avatar, { etag: 'abc123' });
    const icons = await store.getIcons(agentId);
    assert.deepEqual(Buffer.from(icons?.color ?? []), Buffer.from([4, 5]));
    assert.deepEqual(Buffer.from(icons?.outline ?? []), Buffer.from([6]));
    const avatar = await store.getAvatar(agentId);
    assert.deepEqual(Buffer.from(avatar?.bytes ?? []), Buffer.from([1, 2, 3]));
    assert.equal(avatar?.etag, 'abc123');
  });

  it('keeps the colour icon usable when no outline could be derived', async () => {
    await store.setAvatar(agentId, {
      original: new Uint8Array([1]),
      color: new Uint8Array([2]),
      outline: null,
      etag: 'no-outline',
    });
    const icons = await store.getIcons(agentId);
    assert.ok(icons, 'an avatar without an outline is still an avatar');
    assert.equal(icons.outline, null);
  });

  it('an avatar write does not disturb the authored text', async () => {
    await store.save(agentId, { ...EMPTY, displayName: 'Vertrieb' });
    const withAvatar = await store.setAvatar(agentId, {
      original: new Uint8Array([1]),
      color: new Uint8Array([2]),
      outline: null,
      etag: 'e1',
    });
    assert.equal(withAvatar.displayName, 'Vertrieb');
    assert.equal(withAvatar.revision, 2);
  });

  it('clearing an avatar bumps the revision once, and never when there was none', async () => {
    await store.setAvatar(agentId, {
      original: new Uint8Array([1]),
      color: new Uint8Array([2]),
      outline: null,
      etag: 'e1',
    });
    const cleared = await store.clearAvatar(agentId);
    assert.equal(cleared?.avatar, null);
    assert.equal(cleared?.revision, 2);
    assert.equal(await store.getIcons(agentId), undefined);

    const again = await store.clearAvatar(agentId);
    assert.equal(again?.revision, 2, 'a second clear is not a change');
  });

  it('clearing an avatar of an agent without an identity creates nothing', async () => {
    assert.equal(await store.clearAvatar(agentId), undefined);
    assert.equal(await store.getByAgentId(agentId), undefined);
  });

  it('round-trips the character documents through JSONB', async () => {
    const saved = await store.save(agentId, {
      ...EMPTY,
      persona: {
        template: 'customer-service',
        axes: { directness: 80, warmth: 20 },
        custom_notes: 'Antworte auf Deutsch.',
      },
      quality: {
        sycophancy: 'high',
        boundaries: { presets: ['no-pii'], custom: ['Never quote prices.'] },
      },
      composed: { text: '<persona>…</persona>', family: 'opus' },
    });
    assert.equal(saved.persona?.template, 'customer-service');
    assert.equal(saved.persona?.axes?.directness, 80);
    assert.equal(saved.quality?.sycophancy, 'high');
    assert.deepEqual(saved.quality?.boundaries?.presets, ['no-pii']);
    assert.equal(saved.composed.text, '<persona>…</persona>');
    assert.equal(saved.composed.family, 'opus');

    const reread = await store.getByAgentId(agentId);
    assert.deepEqual(reread?.persona, saved.persona);
    assert.deepEqual(reread?.quality, saved.quality);
  });

  it('bumps the revision for a character change that touches no text', async () => {
    const first = await store.save(agentId, {
      ...EMPTY,
      persona: { axes: { directness: 60 } },
      composed: { text: 'a', family: 'sonnet' },
    });
    const second = await store.save(agentId, {
      ...EMPTY,
      persona: { axes: { directness: 90 } },
      composed: { text: 'b', family: 'sonnet' },
    });
    // The Teams package renders this identity, and its manifest version is
    // the revision — a persona-only edit that did not bump it could not be
    // re-published at all.
    assert.equal(second.revision, first.revision + 1);
  });

  it('treats an unchanged character as a no-op save', async () => {
    const persona = { axes: { directness: 60 } };
    const first = await store.save(agentId, {
      ...EMPTY,
      persona,
      composed: { text: 'a', family: 'sonnet' },
    });
    const again = await store.save(agentId, {
      ...EMPTY,
      persona: { axes: { directness: 60 } },
      composed: { text: 'a', family: 'sonnet' },
    });
    assert.equal(again.revision, first.revision);
  });

  it('recompose refreshes the prompt WITHOUT bumping the revision', async () => {
    const saved = await store.save(agentId, {
      ...EMPTY,
      persona: { axes: { directness: 90 } },
      composed: { text: 'built for sonnet', family: 'sonnet' },
    });
    const recomposed = await store.recompose(agentId, {
      text: 'built for opus',
      family: 'opus',
    });
    assert.equal(recomposed?.composed.text, 'built for opus');
    assert.equal(recomposed?.composed.family, 'opus');
    // Nothing the operator authored changed, so nothing about the Teams
    // package did either.
    assert.equal(recomposed?.revision, saved.revision);
  });

  it('recompose on an agent without an identity creates nothing', async () => {
    assert.equal(
      await store.recompose(agentId, { text: 'x', family: 'sonnet' }),
      undefined,
    );
    assert.equal(await store.getByAgentId(agentId), undefined);
  });

  it('drops the identity with its agent', async () => {
    await store.save(agentId, { ...EMPTY, displayName: 'Vertrieb' });
    await pool.query('DELETE FROM agents WHERE id = $1', [agentId]);
    assert.equal(await store.getByAgentId(agentId), undefined);
  });

  // ── #967 — adopting the provisioned Teams name ──────────────────────
  //
  // The refusal is an `ON CONFLICT … DO UPDATE … WHERE` predicate, so it can
  // only be proven against a real Postgres: a read-then-write in the caller
  // would pass the same assertions while still losing a concurrent save.

  it('adopts a name for an agent that has no identity row at all', async () => {
    const adopted = await store.adoptDisplayName(agentId, 'Messias');

    assert.equal(adopted?.displayName, 'Messias');
    assert.equal((await store.getByAgentId(agentId))?.displayName, 'Messias');
    // A fresh row starts at revision 1: the Teams manifest already renders
    // this exact name (it falls back to the provisioning row), so there is no
    // package change to publish and nothing to bump for.
    assert.equal(adopted?.revision, 1);
  });

  it('REFUSES to overwrite an authored name, and leaves the whole row alone', async () => {
    // The condition the whole feature hangs on. Someone built this by hand.
    const curated = await store.save(agentId, {
      ...EMPTY,
      displayName: 'Karen',
      shortDescription: 'Kümmert sich um HR-Anliegen',
      instructions: 'Antworte knapp und freundlich.',
      composed: { text: 'Antworte knapp und freundlich.', family: 'sonnet' },
    });

    const after = await store.adoptDisplayName(agentId, 'Messias');

    assert.equal(after?.displayName, 'Karen');
    assert.equal(after?.shortDescription, 'Kümmert sich um HR-Anliegen');
    assert.equal(after?.instructions, 'Antworte knapp und freundlich.');
    assert.equal(after?.composed.text, 'Antworte knapp und freundlich.');
    // Not even a revision bump or an `updated_at` touch: nothing happened.
    assert.equal(after?.revision, curated.revision);
    assert.deepEqual(after?.updatedAt, curated.updatedAt);
  });

  it('treats a blank authored name as unset and fills it', async () => {
    // `resolveAgentIdentity` already reads blank as "inherit from the
    // registry", so adopting takes nothing away — and the rest of the row
    // must survive untouched.
    await store.save(agentId, {
      ...EMPTY,
      displayName: '   ',
      instructions: 'Antworte knapp.',
    });

    const after = await store.adoptDisplayName(agentId, 'Messias');

    assert.equal(after?.displayName, 'Messias');
    assert.equal(after?.instructions, 'Antworte knapp.');
  });

  it('is idempotent: adopting twice writes once', async () => {
    const first = await store.adoptDisplayName(agentId, 'Messias');
    const second = await store.adoptDisplayName(agentId, 'Messias');

    assert.equal(second?.displayName, 'Messias');
    assert.equal(second?.revision, first?.revision);
    // The second call hit the refusal branch (a name is already authored),
    // so it must not have moved the timestamp either.
    assert.deepEqual(second?.updatedAt, first?.updatedAt);
  });

  it('adopting a blank name creates nothing', async () => {
    // An empty row whose only effect is switching the manifest onto the
    // revision-based version number is worse than no row.
    assert.equal(await store.adoptDisplayName(agentId, '   '), undefined);
    assert.equal(await store.getByAgentId(agentId), undefined);
  });

  it('an adopted name is what the registry joins into the system prompt', async () => {
    // The column the orchestrator's AGENT_SELECT reads (#967). Pinned here so
    // the store and that join cannot drift apart silently — a name in a
    // column nobody reads is the bug this feature exists to fix.
    await store.adoptDisplayName(agentId, 'Messias');
    const { rows } = await pool.query<{ identity_display_name: string | null }>(
      `SELECT i.display_name AS identity_display_name
         FROM agents a LEFT JOIN agent_identities i ON i.agent_id = a.id
        WHERE a.id = $1`,
      [agentId],
    );
    assert.equal(rows[0]?.identity_display_name, 'Messias');
  });
});
