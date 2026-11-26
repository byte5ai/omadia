-- #1823 (ADR-0183) — memorable knowledge is private unless shared on purpose.
--
-- `createMemorableKnowledge` left `visibility` to the column default `team`
-- for every caller that did not pass one: "Save as memory", auto-promotion
-- from turns, MCP ingestion and the scratch reaper before #2141. Recall's
-- team branch admits `team` rows tenant-wide without checking owners or the
-- origin agent, so each of those entries reached every account and agent.
-- New rows are now written `private` by the code; this migration moves the
-- old ones.
--
-- Kept shared: operator durable rules (`created_by = 'system:rules-hook'`,
-- the one caller that asked for `team` on purpose), every `public` row, and
-- every row without owners (scratch-reaper output from before #2141): a
-- private row nobody owns would be unreachable for everyone.
-- A `team` row an operator set by hand is indistinguishable from a defaulted
-- one and becomes private too; re-share it deliberately.
--
-- Idempotent: a re-run finds no defaulted `team` row left.

UPDATE graph_nodes
   SET visibility = 'private'
 WHERE type = 'MemorableKnowledge'
   AND COALESCE(visibility, 'team') = 'team'
   AND COALESCE(properties->>'created_by', '') <> 'system:rules-hook'
   AND jsonb_typeof(properties->'acl_owners') = 'array'
   AND jsonb_array_length(properties->'acl_owners') > 0;
