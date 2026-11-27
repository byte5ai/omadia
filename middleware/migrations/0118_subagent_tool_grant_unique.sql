-- #1939 — idempotent sub-agent tool grants.
--
-- 0014 made a duplicate TOP-LEVEL MCP grant impossible. Sub-agent grants
-- (agent_id NULL, subagent_id set) had no such index, so a second canvas drop
-- of the same tool inserted a second row; the sub-agent then got two tools of
-- the same name, which the model provider rejects for the whole helper.
--
-- First remove the duplicates (keep the oldest row per helper and tool), then
-- make a new one impossible. `mcp_server_id` is NULL for native grants, so the
-- index compares it through COALESCE with the all-zero uuid, the same
-- expression `AgentGraphStore.createToolGrant` names in its ON CONFLICT.

DELETE FROM agent_tool_grants a
 USING agent_tool_grants b
 WHERE a.subagent_id IS NOT NULL
   AND a.agent_id IS NULL
   AND b.subagent_id = a.subagent_id
   AND b.agent_id IS NULL
   AND b.tool_kind = a.tool_kind
   AND b.tool_ref = a.tool_ref
   AND b.mcp_server_id IS NOT DISTINCT FROM a.mcp_server_id
   AND (b.created_at, b.id) < (a.created_at, a.id);

CREATE UNIQUE INDEX IF NOT EXISTS agent_tool_grants_subagent_uidx
  ON agent_tool_grants (
    subagent_id,
    tool_kind,
    tool_ref,
    COALESCE(mcp_server_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE subagent_id IS NOT NULL AND agent_id IS NULL;

-- rollback: DROP INDEX agent_tool_grants_subagent_uidx;
