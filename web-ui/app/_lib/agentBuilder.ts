import { ApiError } from './api';

/**
 * Typed client for the Agent-Builder visual-canvas REST surface
 * (`/api/v1/operator/agents/:slug/graph/*` and the sibling sub-agent /
 * skill / mcp-server / schedule routes). Mirrors the cookie-forwarding +
 * URL conventions from `_lib/agents.ts` and `_lib/api.ts` verbatim so the
 * canvas works identically from RSC fetches and client-side writes.
 *
 * The types here intentionally re-declare the backend contract locally
 * (no cross-package import from `middleware/`) so the web-ui bundle stays
 * self-contained.
 */

function botApi(path: string): string {
  if (typeof window !== 'undefined') {
    return `/bot-api${path}`;
  }
  const base = process.env['MIDDLEWARE_URL'] ?? 'http://localhost:3979';
  return `${base}/api${path}`;
}

async function forwardCookieHeader(): Promise<Record<string, string>> {
  if (typeof window !== 'undefined') return {};
  try {
    const mod = await import('next/headers');
    const jar = await mod.cookies();
    const cookieHeader = jar
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    return cookieHeader ? { cookie: cookieHeader } : {};
  } catch {
    return {};
  }
}

async function callJson<T>(
  path: string,
  init?: RequestInit & { method?: string },
): Promise<T> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(botApi(path), {
    ...init,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...forwarded,
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
    credentials: 'include',
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `${init?.method ?? 'GET'} ${path} failed: ${res.status}`,
      text,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

// -----------------------------------------------------------------------------
// Backend contract types (mirrored locally — do NOT import from middleware)
// -----------------------------------------------------------------------------

export interface CanvasPosition {
  x: number;
  y: number;
}

export type ModelRoutingMode = 'single' | 'triage';
export type EscalationTrigger = 'tool_error' | 'long_context' | 'low_confidence';

export interface ModelRoutingConfig {
  mode: ModelRoutingMode;
  main: string;
  triage?: string;
  simple?: string;
  escalateOn?: EscalationTrigger[];
}

export type PrivacyProfile = 'strict' | 'default';
export type NodeStatus = 'enabled' | 'disabled';

export interface AgentNode {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  privacyProfile: PrivacyProfile;
  status: NodeStatus;
  modelRouting: ModelRoutingConfig | null;
  position: CanvasPosition | null;
}

export interface ChannelNode {
  channelType: string;
  channelKey: string;
  position: CanvasPosition | null;
}

export interface SubAgentNode {
  id: string;
  parentAgentId: string;
  name: string;
  skillId: string | null;
  model: string | null;
  maxTokens: number | null;
  maxIterations: number | null;
  systemPromptOverride: string | null;
  status: NodeStatus;
  position: CanvasPosition | null;
}

export interface SkillNode {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  body: string;
  source: 'db' | 'file';
}

export type ToolKind = 'native' | 'mcp';

export interface ToolGrantNode {
  id: string;
  agentId: string | null;
  subAgentId: string | null;
  toolKind: ToolKind;
  toolRef: string;
  mcpServerId: string | null;
}

export interface McpDiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpServerNode {
  id: string;
  name: string;
  transport: McpTransport;
  endpoint: string | null;
  status: NodeStatus;
  lastDiscoveredAt: string | null;
  discoveredTools: McpDiscoveredTool[];
}

export interface ScheduleNode {
  id: string;
  agentId: string;
  cron: string;
  timezone: string;
  payload: Record<string, unknown>;
  status: NodeStatus;
  lastRunAt: string | null;
}

/** Read-only mirror of an enabled plugin on the agent (current-system view). */
export interface PluginNode {
  id: string;
}

export type EdgeKind =
  | 'channel_bind'
  | 'subagent'
  | 'skill'
  | 'tool_grant'
  | 'schedule'
  | 'plugin';

export interface CanvasEdge {
  id: string;
  kind: EdgeKind;
  source: string;
  target: string;
}

export interface AgentGraph {
  agent: AgentNode;
  channels: ChannelNode[];
  subAgents: SubAgentNode[];
  skills: SkillNode[];
  tools: ToolGrantNode[];
  mcpServers: McpServerNode[];
  schedules: ScheduleNode[];
  plugins: PluginNode[];
  edges: CanvasEdge[];
}

// -----------------------------------------------------------------------------
// Graph read + edge mutations
// -----------------------------------------------------------------------------

export async function getAgentGraph(slug: string): Promise<AgentGraph> {
  return callJson<AgentGraph>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/graph`,
  );
}

export interface CreateEdgeInput {
  kind: EdgeKind;
  source: string;
  target: string;
  config?: Record<string, unknown>;
}

export interface CreateEdgeResponse {
  edge: CanvasEdge;
  diff?: unknown;
}

export async function createGraphEdge(
  slug: string,
  input: CreateEdgeInput,
): Promise<CreateEdgeResponse> {
  return callJson<CreateEdgeResponse>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/graph/edges`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export async function deleteGraphEdge(
  slug: string,
  edgeId: string,
  kind: EdgeKind,
): Promise<void> {
  const params = new URLSearchParams({ kind });
  await callJson(
    `/v1/operator/agents/${encodeURIComponent(slug)}/graph/edges/${encodeURIComponent(edgeId)}?${params.toString()}`,
    { method: 'DELETE' },
  );
}

// -----------------------------------------------------------------------------
// Sub-agents
// -----------------------------------------------------------------------------

export interface CreateSubAgentInput {
  name: string;
  skillId?: string | null;
  model?: string | null;
  maxTokens?: number | null;
  maxIterations?: number | null;
  systemPromptOverride?: string | null;
  status?: NodeStatus;
  position?: CanvasPosition;
}

export async function createSubAgent(
  slug: string,
  input: CreateSubAgentInput,
): Promise<SubAgentNode> {
  return callJson<SubAgentNode>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/subagents`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export type PatchSubAgentInput = Partial<CreateSubAgentInput>;

export async function patchSubAgent(
  slug: string,
  id: string,
  patch: PatchSubAgentInput,
): Promise<SubAgentNode> {
  return callJson<SubAgentNode>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/subagents/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  );
}

export async function deleteSubAgent(slug: string, id: string): Promise<void> {
  await callJson(
    `/v1/operator/agents/${encodeURIComponent(slug)}/subagents/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
}

// -----------------------------------------------------------------------------
// Model routing + positions
// -----------------------------------------------------------------------------

export async function patchModelRouting(
  slug: string,
  modelRouting: ModelRoutingConfig | null,
): Promise<AgentNode> {
  return callJson<AgentNode>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/model-routing`,
    { method: 'PATCH', body: JSON.stringify({ modelRouting }) },
  );
}

export interface PositionsPatchInput {
  agent?: CanvasPosition;
  subAgents?: Array<{ id: string; position: CanvasPosition }>;
  channels?: Array<{
    channelType: string;
    channelKey: string;
    position: CanvasPosition;
  }>;
}

export async function patchPositions(
  slug: string,
  input: PositionsPatchInput,
): Promise<void> {
  await callJson(
    `/v1/operator/agents/${encodeURIComponent(slug)}/positions`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
}

// -----------------------------------------------------------------------------
// Skills (global registry)
// -----------------------------------------------------------------------------

export interface SkillsListResponse {
  skills: SkillNode[];
}

export async function listSkills(): Promise<SkillsListResponse> {
  return callJson<SkillsListResponse>('/v1/operator/skills');
}

export interface CreateSkillInput {
  slug: string;
  name: string;
  description?: string | null;
  body: string;
}

export async function createSkill(input: CreateSkillInput): Promise<SkillNode> {
  return callJson<SkillNode>('/v1/operator/skills', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export type PatchSkillInput = Partial<CreateSkillInput>;

export async function patchSkill(
  id: string,
  patch: PatchSkillInput,
): Promise<SkillNode> {
  return callJson<SkillNode>(`/v1/operator/skills/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deleteSkill(id: string): Promise<void> {
  await callJson(`/v1/operator/skills/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

// -----------------------------------------------------------------------------
// MCP servers
// -----------------------------------------------------------------------------

export interface McpServersListResponse {
  servers: McpServerNode[];
}

export async function listMcpServers(): Promise<McpServersListResponse> {
  return callJson<McpServersListResponse>('/v1/operator/mcp-servers');
}

export interface CreateMcpServerInput {
  name: string;
  transport: McpTransport;
  endpoint?: string | null;
  status?: NodeStatus;
}

export async function createMcpServer(
  input: CreateMcpServerInput,
): Promise<McpServerNode> {
  return callJson<McpServerNode>('/v1/operator/mcp-servers', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function deleteMcpServer(id: string): Promise<void> {
  await callJson(`/v1/operator/mcp-servers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function discoverMcpTools(id: string): Promise<McpServerNode> {
  return callJson<McpServerNode>(
    `/v1/operator/mcp-servers/${encodeURIComponent(id)}/discover`,
    { method: 'POST' },
  );
}

// -----------------------------------------------------------------------------
// Schedules
// -----------------------------------------------------------------------------

export interface SchedulesListResponse {
  schedules: ScheduleNode[];
}

export async function listSchedules(
  slug: string,
): Promise<SchedulesListResponse> {
  return callJson<SchedulesListResponse>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/schedules`,
  );
}

export interface CreateScheduleInput {
  cron: string;
  timezone: string;
  payload?: Record<string, unknown>;
  status?: NodeStatus;
}

export async function createSchedule(
  slug: string,
  input: CreateScheduleInput,
): Promise<ScheduleNode> {
  return callJson<ScheduleNode>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/schedules`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export async function deleteSchedule(slug: string, id: string): Promise<void> {
  await callJson(
    `/v1/operator/agents/${encodeURIComponent(slug)}/schedules/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
}

// -----------------------------------------------------------------------------
// Edge semantics — single source of truth for legal connections.
// Encoded as source-node-kind → target-node-kind → edge-kind. The canvas
// stamps each ReactFlow node with a `kind` in its data; `isValidConnection`
// looks the pair up here.
// -----------------------------------------------------------------------------

export type CanvasNodeKind =
  | 'channel'
  | 'agent'
  | 'subagent'
  | 'skill'
  | 'tool'
  | 'mcp'
  | 'schedule'
  | 'plugin';

interface EdgeRule {
  source: CanvasNodeKind;
  target: CanvasNodeKind;
  kind: EdgeKind;
}

const EDGE_RULES: readonly EdgeRule[] = [
  { source: 'channel', target: 'agent', kind: 'channel_bind' },
  { source: 'agent', target: 'subagent', kind: 'subagent' },
  { source: 'subagent', target: 'skill', kind: 'skill' },
  { source: 'agent', target: 'tool', kind: 'tool_grant' },
  { source: 'agent', target: 'mcp', kind: 'tool_grant' },
  { source: 'subagent', target: 'tool', kind: 'tool_grant' },
  { source: 'subagent', target: 'mcp', kind: 'tool_grant' },
  { source: 'schedule', target: 'agent', kind: 'schedule' },
];

/**
 * Resolve the edge-kind for a directed source→target node-kind pair, or
 * `null` when the connection is illegal. Used both by `isValidConnection`
 * (reject illegal drags) and `onConnect` (derive the kind to POST).
 */
export function resolveEdgeKind(
  source: CanvasNodeKind,
  target: CanvasNodeKind,
): EdgeKind | null {
  const rule = EDGE_RULES.find(
    (r) => r.source === source && r.target === target,
  );
  return rule ? rule.kind : null;
}

/** Hardcoded native-tool catalog surfaced in the toolbox palette. */
export const NATIVE_TOOLS: readonly string[] = [
  'web_search',
  'query_knowledge_graph',
  'render_diagram',
  'book_meeting',
  'find_free_slots',
];
