-- 0002_user_scoping.sql
-- Add user-level scoping to the graph so per-user session filtering becomes
-- a first-class query instead of a post-hoc join. Nullable: existing rows
-- predate the concept and stay legacy (NULL) — dev-route filters must treat
-- NULL as "belongs to no one specific" rather than matching every userId.

ALTER TABLE graph_nodes
  ADD COLUMN IF NOT EXISTS user_id TEXT;

CREATE INDEX IF NOT EXISTS graph_nodes_user_idx
  ON graph_nodes (tenant_id, user_id, type) WHERE user_id IS NOT NULL;

-- Composite covering index for the most common filter: "this user's sessions,
-- most recent first". Lets listSessions skip a sort when a userId is given.
CREATE INDEX IF NOT EXISTS graph_nodes_user_scope_idx
  ON graph_nodes (tenant_id, user_id, type, scope)
  WHERE user_id IS NOT NULL;
