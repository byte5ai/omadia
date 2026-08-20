-- ── Plugin → SQL / schema-ownership grants (epic #470 C7 / G4) ─────────────
-- The operator explicitly consents to a plugin holding a Postgres pool and
-- owning tables in the operator's own database. Deny-by-default: a plugin may
-- declare `permissions.sql` in its manifest, but `ctx.services.get('graphPool')`
-- keeps throwing and `ctx.sql` stays undefined until a row exists here.
--
-- Sibling of `plugin_public_path_grants` (C4 / H1) and `plugin_mcp_grants`
-- (#458) for the same reason: plugins have no agents-table row, so per-plugin
-- consent cannot be a scope on an existing grants table.
--
-- WHY BOTH KEYS ARE UNIQUE
-- ------------------------
-- `PRIMARY KEY (plugin_id)` — one plugin owns at most one ledger. Two ledgers
-- for one plugin would mean two independent migration histories for one
-- package, and nothing could then say which one is authoritative.
--
-- `UNIQUE (ledger)` — one ledger belongs to at most one plugin, FOREVER. This
-- is the actual anti-hijack enforcement. `platform/pluginSqlGrants.ts` also
-- requires the ledger name to live inside the kernel-owned
-- `plg_<sanitized-plugin-id>_<suffix>` namespace, but that prefix rule is
-- defence-in-depth and not airtight on its own: for plugins `acme_tool` and
-- `acme_tool_extra`, a name like `plg_acme_tool_extra_mig` carries BOTH
-- per-plugin prefixes, so the syntactic check alone would let the first plugin
-- claim the second one's ledger. A database-level uniqueness constraint has no
-- such edge: whoever is granted the name first holds it, and the second grant
-- fails loudly instead of silently sharing a migration history.
--
-- `ledger` is stored verbatim as declared and is re-validated against the
-- charset allowlist on every use before it is quoted into DDL — the table is a
-- record of consent, never a trusted source of identifiers.
CREATE TABLE IF NOT EXISTS plugin_sql_grants (
  plugin_id  TEXT NOT NULL,
  ledger     TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin_id),
  UNIQUE (ledger)
);

-- rollback: DROP TABLE plugin_sql_grants;
