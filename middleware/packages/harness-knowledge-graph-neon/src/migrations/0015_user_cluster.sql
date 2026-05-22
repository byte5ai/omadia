BEGIN;

-- Slice 1b — User-Cluster + ChannelIdentity introduction.
--
-- Strategy (per Decision-Lock L2, 2026-05-13 revision): we are still in
-- early dev-preview / pre-public OSS, so there is no production state
-- worth migrating. Wipe the entire knowledge graph + dependent state
-- tables. The new ingest path repopulates everything from scratch with
-- the cluster-aware schema (User as cluster root, ChannelIdentity as
-- channel-bound leaf, IS_IDENTITY_OF edge).
--
-- Schema-level support for the new node + edge types is implicit: the
-- single-table-discriminator architecture carries them via the Zod
-- validator (see `schema.ts`), so no DDL is needed.
--
-- Tables wiped (all KG-package tables that reference graph_nodes/edges):
--   - graph_edges       (0001)
--   - graph_nodes       (0001)
--   - processes         (0009 — process-memory, references user/turn)
--   - process_history   (0009)
--   - nudge_state       (0010 — references run nodes)
--   - nudge_emissions   (0010)
--   - agent_priorities  (0008 — plugin-side priority data, safe to reset)
--
-- TRUNCATE … CASCADE drops every FK-dependent row in one statement and
-- resets sequences. RESTART IDENTITY is implicit on TRUNCATE.

TRUNCATE TABLE
  graph_edges,
  graph_nodes,
  processes,
  process_history,
  nudge_state,
  nudge_emissions,
  agent_priorities
CASCADE;

-- Optional supporting index for cross-channel cluster-merge: lookup
-- ChannelIdentities by (tenant_id, lower(email)) when emailVerified=true.
-- Partial — only verified emails are merge-keys, so the index stays
-- small even with many anonymous Telegram identities.
CREATE INDEX IF NOT EXISTS idx_channel_identity_verified_email
  ON graph_nodes (tenant_id, lower(properties->>'email'))
  WHERE type = 'ChannelIdentity'
    AND (properties->>'emailVerified')::boolean = true
    AND properties->>'email' IS NOT NULL;

COMMIT;
