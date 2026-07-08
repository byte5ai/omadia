-- Epic #459 / issue #463 item 5 — move MCP registry bearer tokens out of the DB.
--
-- `mcp_registries.token` (added in 0010) stored the optional bearer credential
-- for a catalog source as PLAINTEXT. That is the wrong storage class for a
-- secret-at-rest: registry tokens now live ONLY in the SecretVault (namespace
-- `@omadia/mcp-registry`, key = registry id), exactly like schema-driven MCP
-- server-config secrets (0019, namespace `@omadia/mcp-config`).
--
-- Expand/contract: this migration is the EXPAND step. The column is retained
-- (nullable) as the source for the one-time, idempotent boot backfill
-- (`backfillMcpRegistryTokens`), which moves any legacy plaintext token into
-- the vault and NULLs the column. Application code no longer reads or writes
-- this column. Dropping it is the CONTRACT step, deferred to a later release
-- once every deployment has booted through the backfill at least once.
COMMENT ON COLUMN mcp_registries.token IS
  'DEPRECATED (issue #463 item 5). Registry bearer tokens live in the SecretVault '
  '(@omadia/mcp-registry, key = registry id), never here. Retained only as the '
  'backfill source; NULLed at boot and dropped in a later migration.';

-- rollback: COMMENT ON COLUMN mcp_registries.token IS NULL;
