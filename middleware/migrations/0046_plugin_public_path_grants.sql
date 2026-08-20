-- ── Plugin → public-path grants (epic #470 C4 / H1) ────────────────────────
-- The operator explicitly consents to a plugin serving a URL prefix WITHOUT an
-- operator session. Deny-by-default: a plugin may declare
-- `permissions.public_paths` in its manifest, but nothing is served publicly
-- until a row exists here for that exact prefix.
--
-- `plugin_id` is the manifest identity string — plugins have no agents-table
-- row, which is why this is a sibling table rather than a scope on an existing
-- grants table (same decision recorded on #458 for `plugin_mcp_grants`).
--
-- `path_prefix` is stored verbatim as declared. It is matched by exact-prefix
-- comparison on a segment boundary at request time, never as SQL LIKE and
-- never as a regex — a stored value can therefore not widen its own match.
-- The composite PK makes re-granting idempotent and makes it impossible for
-- one plugin to hold two conflicting rows for the same prefix; cross-plugin
-- exclusivity is enforced in `platform/publicPathGrants.ts` at activation
-- time, because it has to hold for DECLARED prefixes too, not just granted
-- ones.
CREATE TABLE IF NOT EXISTS plugin_public_path_grants (
  plugin_id   TEXT NOT NULL,
  path_prefix TEXT NOT NULL,
  granted_by  TEXT NOT NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin_id, path_prefix)
);

-- rollback: DROP TABLE plugin_public_path_grants;
