/**
 * ADR-0255 — a SQL grant on the borrowed `graphPool` covers the plugin's own
 * tables. The guard tokenises each statement and refuses one that names a
 * kernel relation, or that it cannot read with certainty.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  SqlTableRefusedError,
  assertPluginStatement,
  checkedPluginStatement,
  sqlRefusalReason,
} from '../src/platform/sqlTableGuard.js';

const UPLOAD = '@acme/tool';

describe('ADR-0255 · sqlTableGuard', () => {
  it('passes a plugin’s statements on its own tables', () => {
    for (const sql of [
      'SELECT id, payload FROM acme_items WHERE id = $1',
      "INSERT INTO acme_items (id, note) VALUES ($1, 'graph_nodes are mentioned in a string')",
      'CREATE TABLE IF NOT EXISTS acme_items (id text PRIMARY KEY, created_at timestamptz DEFAULT now())',
      'INSERT INTO acme_items (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      "SELECT E'it\\'s graph_nodes' AS label -- a comment naming turn_receipts\nFROM acme_items",
      'SELECT 1 /* users /* nested */ processes */ FROM acme_items',
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      'CREATE TABLE plg_acme_tool_migrations (id text)',
      'SELECT * FROM plg_acme_tool.items',
    ]) {
      assert.equal(sqlRefusalReason(UPLOAD, sql), undefined, sql);
    }
  });

  it('refuses a statement naming a kernel table, however it is spelled', () => {
    for (const sql of [
      'SELECT * FROM graph_nodes',
      'select * from GRAPH_NODES',
      'SELECT * FROM public.graph_nodes',
      'SELECT * FROM "graph_nodes"',
      'SELECT * FROM "public"."memory_files"',
      'SELECT a.id FROM acme_items a JOIN processes p ON p.id = a.id',
      'SELECT 1; SELECT * FROM users',
      'WITH x AS (SELECT * FROM turn_receipts) SELECT * FROM x',
      'CREATE VIEW acme_v AS SELECT * FROM graph_edges',
      'COPY agents TO STDOUT',
      'SELECT * FROM acme_items, credentials',
    ]) {
      assert.match(sqlRefusalReason(UPLOAD, sql) ?? '', /kernel relation/, sql);
    }
  });

  it('fails closed on what it cannot read', () => {
    for (const [sql, reason] of [
      ["SELECT 'unterminated", /unterminated string/],
      ['SELECT "unterminated', /unterminated quoted identifier/],
      ['SELECT 1 /* open', /unterminated block comment/],
      ['SELECT $$graph_nodes$$', /dollar-quoted/],
      ['SELECT $tag$x$tag$', /dollar-quoted/],
      ['SELECT * FROM U&"\\0067raph_nodes"', /U& escapes/],
      ["DO 'BEGIN PERFORM 1; END'", /DO block/],
      ["; do 'x'", /DO block/],
      ["CREATE FUNCTION f() RETURNS int AS 'select 1' LANGUAGE sql", /function body/],
      ["CREATE OR REPLACE PROCEDURE p() AS 'select 1' LANGUAGE sql", /procedure body/],
      ["SELECT query_to_xml('select * from gr' || 'aph_nodes', true, true, '')", /query_to_xml/],
      ["SELECT table_to_xml('graph_' || 'nodes', true, true, '')", /table_to_xml/],
      ["SELECT ts_stat('select vec from ' || 'graph_nodes')", /ts_stat/],
      ['SELECT * FROM plg_other_plugin_migrations', /another plugin/],
      ['SELECT * FROM plg_acme_toolbox.items', /another plugin/],
      ['SET standard_conforming_strings = off', /standard_conforming_strings/],
      ["SELECT set_config('standard_conforming_strings', 'off', false)", /set_config/],
      ['SET backslash_quote = on', /backslash_quote/],
      ["SELECT most_common_vals::text FROM pg_stats WHERE tablename = 'users'", /pg_stats/],
      ['LISTEN agents_changed_channel', /LISTEN/],
      ["NOTIFY acme, 'x'", /NOTIFY/],
      ["SELECT pg_notify('agents', 'x')", /pg_notify/],
    ] as const) {
      assert.match(sqlRefusalReason(UPLOAD, sql) ?? '', reason, sql);
    }
  });

  it('lets a Hub plugin use the kernel-created tables it owns, and nobody else', () => {
    assert.equal(sqlRefusalReason('@omadia/channel-teams', 'SELECT * FROM teams_conversation_refs'), undefined);
    assert.equal(sqlRefusalReason('@omadia/dev-platform', 'UPDATE dev_jobs SET status = $1'), undefined);
    assert.match(sqlRefusalReason('@omadia/channel-teams', 'SELECT * FROM dev_jobs') ?? '', /kernel relation/);
    assert.match(sqlRefusalReason(UPLOAD, 'SELECT * FROM teams_attachments') ?? '', /kernel relation/);
    assert.match(sqlRefusalReason('@omadia/channel-teams', 'SELECT * FROM graph_nodes') ?? '', /kernel relation/);
  });

  it('reads the text of a query config and refuses one without text', () => {
    assert.doesNotThrow(() => assertPluginStatement(UPLOAD, { text: 'SELECT 1', values: [] }));
    assert.throws(() => assertPluginStatement(UPLOAD, { text: 'SELECT * FROM agents' }), SqlTableRefusedError);
    assert.throws(() => assertPluginStatement(UPLOAD, { submit: () => undefined }), /submittable/);
    assert.throws(
      () => assertPluginStatement(UPLOAD, { text: 'SELECT 1', submit: () => undefined }),
      /submittable/,
    );
    assert.throws(() => assertPluginStatement(UPLOAD, undefined), SqlTableRefusedError);
  });

  it('hands pg a copy whose text is the text it checked', () => {
    let reads = 0;
    const tricky = {
      get text(): string {
        reads += 1;
        return reads <= 1 ? 'SELECT 1' : 'SELECT * FROM users';
      },
      values: [1],
    };
    const statement = checkedPluginStatement(UPLOAD, tricky);
    assert.deepEqual(statement, { text: 'SELECT 1', values: [1], name: undefined, rowMode: undefined, types: undefined });
    assert.ok(Object.isFrozen(statement));
  });
});
