-- 0003_agentic_graph.sql
-- No structural changes — the generic graph_nodes / graph_edges tables already
-- accept arbitrary node/edge types. What's added here is query-shape-specific:
-- partial indexes for the Run / AgentInvocation / ToolCall surface so the
-- agentic dashboard queries (e.g. "all Runs for this User in the last 24h",
-- "top-5 slowest ToolCalls", "failure-rate per AgentInvocation") don't full-
-- scan once the tables grow past a few million rows.

-- Fast "recent runs for a user" via covering Run-by-user-chronological.
CREATE INDEX IF NOT EXISTS graph_nodes_run_user_time_idx
  ON graph_nodes (tenant_id, user_id, (properties->>'startedAt') DESC)
  WHERE type = 'Run' AND user_id IS NOT NULL;

-- Failure-rate queries: "ToolCalls with isError=true, grouped by toolName".
CREATE INDEX IF NOT EXISTS graph_nodes_toolcall_error_idx
  ON graph_nodes (tenant_id, (properties->>'toolName'))
  WHERE type = 'ToolCall' AND (properties->>'isError')::boolean = true;

-- Slowest calls: "top-N ToolCall by durationMs".
CREATE INDEX IF NOT EXISTS graph_nodes_toolcall_duration_idx
  ON graph_nodes (tenant_id, ((properties->>'durationMs')::int) DESC)
  WHERE type = 'ToolCall';

-- AgentInvocation by agentName + status for per-agent dashboards.
CREATE INDEX IF NOT EXISTS graph_nodes_agent_name_idx
  ON graph_nodes (tenant_id, (properties->>'agentName'), (properties->>'status'))
  WHERE type = 'AgentInvocation';
