/**
 * Agent Builder canvas — shared graph contract (P0).
 *
 * The visual builder is a thin renderer over the config graph: every node is
 * a DB row, every edge is a relationship row. This module is the wire shape
 * that the backend (`GET /api/v1/operator/agents/:slug/graph`) serialises and
 * the web-ui canvas (xyflow) renders/mutates. Pure types — no runtime deps —
 * so both sides import the same contract from the plugin-api surface.
 *
 * Edge semantics (what drawing a connection does):
 *   channel_bind  Channel  → Agent       create channel_bindings row
 *   subagent      Agent    → Sub-Agent   attach agent_subagents row
 *   skill         Sub-Agent→ Skill       set agent_subagents.skill_id
 *   tool_grant    Agent|Sub→ Tool|MCP    insert agent_tool_grants row
 *   schedule      Schedule → Agent       insert agent_schedules row
 */

/** Cosmetic canvas coordinate persisted alongside the node's row. */
export interface CanvasPosition {
  readonly x: number;
  readonly y: number;
}

// ── model routing (persisted on agents.model_routing) ──────────────────────

export type ModelRoutingMode = 'single' | 'triage';

/** A condition that escalates a triage-routed turn from the cheap to the main model. */
export type EscalationTrigger = 'tool_error' | 'long_context' | 'low_confidence';

export interface ModelRoutingConfig {
  readonly mode: ModelRoutingMode;
  /** Primary / complex-turn model id, e.g. 'claude-opus-4-8'. */
  readonly main: string;
  /** Cheap classifier model that decides simple-vs-complex per turn, e.g.
   *  'claude-haiku-4-5'. Used when mode='triage'. */
  readonly triage?: string;
  /** Model for simple turns under triage, e.g. 'claude-sonnet-4-6'.
   *  Defaults to `main` when omitted (degenerate triage = no savings). */
  readonly simple?: string;
  /** Conditions under which a triage turn escalates to `main`. */
  readonly escalateOn?: readonly EscalationTrigger[];
}

// ── node DTOs ───────────────────────────────────────────────────────────────

export interface AgentNode {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly privacyProfile: 'strict' | 'default';
  readonly status: 'enabled' | 'disabled';
  readonly modelRouting: ModelRoutingConfig | null;
  readonly position: CanvasPosition | null;
}

export interface ChannelNode {
  readonly channelType: string;
  readonly channelKey: string;
  readonly position: CanvasPosition | null;
}

export interface SubAgentNode {
  readonly id: string;
  readonly parentAgentId: string;
  readonly name: string;
  readonly skillId: string | null;
  readonly model: string | null;
  readonly maxTokens: number | null;
  readonly maxIterations: number | null;
  readonly systemPromptOverride: string | null;
  readonly status: 'enabled' | 'disabled';
  readonly position: CanvasPosition | null;
}

export type SkillSource = 'db' | 'file';

export interface SkillNode {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly body: string;
  readonly source: SkillSource;
}

export type ToolKind = 'native' | 'mcp';

/** A tool granted to an agent or sub-agent (one grant = one canvas edge). */
export interface ToolGrantNode {
  readonly id: string;
  /** Set when the grant belongs to the top-level agent. */
  readonly agentId: string | null;
  /** Set when the grant belongs to a sub-agent. */
  readonly subAgentId: string | null;
  readonly toolKind: ToolKind;
  /** Native tool name, or "<mcpServerName>:<toolName>" for MCP tools. */
  readonly toolRef: string;
  readonly mcpServerId: string | null;
}

export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpDiscoveredTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

export interface McpServerNode {
  readonly id: string;
  readonly name: string;
  readonly transport: McpTransport;
  readonly endpoint: string | null;
  readonly status: 'enabled' | 'disabled';
  readonly lastDiscoveredAt: string | null;
  readonly discoveredTools: readonly McpDiscoveredTool[];
}

export interface ScheduleNode {
  readonly id: string;
  readonly agentId: string;
  readonly cron: string;
  readonly timezone: string;
  readonly payload: Record<string, unknown>;
  readonly status: 'enabled' | 'disabled';
  readonly lastRunAt: string | null;
}

// ── edges ─────────────────────────────────────────────────────────────────

export type EdgeKind =
  | 'channel_bind'
  | 'subagent'
  | 'skill'
  | 'tool_grant'
  | 'schedule';

export interface CanvasEdge {
  /** Stable id (the underlying row id, or a composite key for channel binds). */
  readonly id: string;
  readonly kind: EdgeKind;
  /** Canvas node id of the edge source. */
  readonly source: string;
  /** Canvas node id of the edge target. */
  readonly target: string;
}

/** Full canvas payload for a single agent. */
export interface AgentGraph {
  readonly agent: AgentNode;
  readonly channels: readonly ChannelNode[];
  readonly subAgents: readonly SubAgentNode[];
  readonly skills: readonly SkillNode[];
  readonly tools: readonly ToolGrantNode[];
  readonly mcpServers: readonly McpServerNode[];
  readonly schedules: readonly ScheduleNode[];
  readonly edges: readonly CanvasEdge[];
}

/** Body of POST /api/v1/operator/agents/:slug/graph/edges. */
export interface CreateEdgeRequest {
  readonly kind: EdgeKind;
  readonly source: string;
  readonly target: string;
  readonly config?: Record<string, unknown>;
}
