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
  /** #1033 — the agent's model policy (absent on a pre-W2 middleware). */
  modelPolicy?: {
    primary: 'auto' | { provider: string; model: string; effort?: string };
    fallback: 'none' | 'auto' | { provider: string; model: string; effort?: string };
  };
  /** #1033 — what the fallback resolves to (`provider:model`, the auto model, or null). */
  effectiveFallback?: string | null;
  /**
   * Resolved orchestrator model the registry currently runs this Agent on
   * (per-Agent overlay applied to the platform default). `null` when the
   * registry has not yet built the Agent (in-memory bootstrap / Agent
   * disabled). Issue #296 acceptance #4.
   */
  effectiveModel: string | null;
  position: CanvasPosition | null;
  /** Wave 8 — direct-answer persona-skill ids attached to this Agent. */
  personaSkillIds?: string[];
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
  frontmatter?: Record<string, unknown>;
  sourcePath?: string | null;
  contentHash?: string | null;
  forkedFrom?: string | null;
  /** Wave 5 heuristic scan, current as of the last `GET /skills` list load
   *  (only populated on the bulk-list endpoint, not on individual skill
   *  reads/writes). */
  risks?: SkillRisk[];
  /** Cached verdict (issue #436) — read-only signal, never a safety guarantee. */
  verdict?: SkillVerdict;
}

/**
 * Heuristic-signal severities (issue #436 — Nvidia OpenClaw/SkillSpector eval).
 * Deliberately never "clean"/"safe"/"verified": a regex/LLM scan is evidence,
 * not proof, and labeling its best case as an affirmative safety claim would
 * make operators *less* cautious than today's warn-only baseline.
 */
export type SkillVerdictSeverity =
  | 'no_signals'
  | 'flagged'
  | 'high_risk'
  | 'scan_failed'
  | 'too_large_to_scan'
  | 'pending'
  | 'not_yet_scanned';

export interface SkillVerdict {
  // Nullable to match what the backend can actually emit (no deterministic
  // row and no LLM row yet) — every call site already coalesces via
  // `?? 'not_yet_scanned'`, this just makes the type honest about it.
  severity: SkillVerdictSeverity | null;
  riskCodes: string[];
  computedAt?: string | null;
  ackedBy?: string | null;
  ackedAt?: string | null;
  /** Phase 1b LLM sub-result, surfaced by GET /skills/:id only. */
  llm?: { severity: SkillVerdictSeverity; rationale: string | null; computedAt: string } | null;
}

export type ToolKind = 'native' | 'mcp';

export interface ToolGrantNode {
  id: string;
  agentId: string | null;
  subAgentId: string | null;
  toolKind: ToolKind;
  toolRef: string;
  mcpServerId: string | null;
  // NOTE deliberately NO `grantEpoch` here: the middleware's `toolGrantNode()`
  // serializer (canvas graph payload) does not emit it. The grant epoch is
  // surfaced by exactly two wire shapes — `AgentToolGrantRowDto.grant_epoch`
  // (GET /v1/operator/agents/:slug/grants, agents.ts) and
  // `McpGrantMatrixRow.grantEpoch` (GET /mcp-grants) — read it from those.
}

/** Scan verdict decoration on a discovered MCP tool (issue #454). Absent on
 *  payloads from middleware builds that predate the scan gate. */
export interface McpToolVerdictField {
  severity: SkillVerdictSeverity | null;
  riskCodes: string[];
  notYetScanned: boolean;
  acked: boolean;
  /** An ack exists but was given for different tool content — treated as absent. */
  ackStale: boolean;
}

export interface McpDiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** Issue #547 (W1-3) — the tool's declared JSON-Schema for its
   *  `structuredContent` payload. Present ⇒ the tool returns structured output
   *  in addition to text. Read-only signal for the operator. */
  outputSchema?: Record<string, unknown>;
  verdict?: McpToolVerdictField;
}

export type McpTransport = 'stdio' | 'http' | 'sse';

/**
 * Transports MCP 2026-07-28 deprecated (issue #541). Mirrors the middleware's
 * `DEPRECATED_MCP_TRANSPORTS`; the union above deliberately keeps `'sse'` —
 * legacy servers stay fully usable during the 12-month removal window, they are
 * only discouraged for new registrations.
 */
export const DEPRECATED_MCP_TRANSPORTS: readonly McpTransport[] = ['sse'];

export interface McpServerNode {
  id: string;
  name: string;
  transport: McpTransport;
  /** Issue #541 — server-derived deprecation flag; absent on older middleware. */
  transportDeprecated?: boolean;
  endpoint: string | null;
  status: NodeStatus;
  lastDiscoveredAt: string | null;
  discoveredTools: McpDiscoveredTool[];
  /** Marketplace provenance (issue #455); absent on older middleware builds. */
  source?: 'manual' | 'marketplace';
  registryId?: string | null;
  license?: string | null;
  author?: string | null;
  sourceUrl?: string | null;
  /** Epic #459 — server opted out of Privacy Shield masking (results unmasked). */
  privacyBypass?: boolean;
  /** Epic #459 — server opted into Knowledge-Graph ingestion of tool results. */
  kgIngest?: boolean;
  /** Epic #459 — declared config fields (from placeholders or a registry). */
  configSchema?: McpConfigField[];
  /** Issue #862 — per-SERVER identity delegation mode (W0-1): every
   *  assignment of this server acts under the same identity resolution, so
   *  an assignment UI shows this value read-only and changes it via
   *  {@link setMcpServerDelegation} (global effect for every agent holding a
   *  grant on the server); absent on older middleware. */
  delegation?: McpDelegation;
}

/** Epic #459 — a declared MCP server config field. */
export interface McpConfigField {
  key: string;
  label: string;
  type: 'string' | 'number';
  required: boolean;
  secret: boolean;
}

export interface McpServerConfigState {
  schema: McpConfigField[];
  config: Record<string, unknown>;
  /** Which secret fields currently have a stored value (not the values). */
  secretsSet: Record<string, boolean>;
}

/** Fetch a server's config schema + non-secret values + which secrets are set. */
export async function getMcpServerConfig(id: string): Promise<McpServerConfigState> {
  return callJson<McpServerConfigState>(
    `/v1/operator/mcp-servers/${encodeURIComponent(id)}/config`,
  );
}

/** Save a server's config: schema (incl. per-field secret flags), non-secret
 *  values, and any secret values (secrets go to the Vault server-side). */
export async function saveMcpServerConfig(
  id: string,
  body: {
    schema?: McpConfigField[];
    config?: Record<string, unknown>;
    secrets?: Record<string, string>;
  },
): Promise<McpServerNode> {
  return callJson<McpServerNode>(`/v1/operator/mcp-servers/${encodeURIComponent(id)}/config`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
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

export type EdgeKind =
  | 'channel_bind'
  | 'subagent'
  | 'skill'
  | 'tool_grant'
  | 'schedule'
  | 'persona_skill';

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

// -----------------------------------------------------------------------------
// Wave 8 — direct-answer persona skills
// -----------------------------------------------------------------------------

export interface PersonaSkillLink {
  agentId: string;
  skillId: string;
  position: number;
  /** Wave 5 guard, re-run at attach time — warn-only, never blocks. */
  risks: SkillRisk[];
}

export async function addPersonaSkill(
  slug: string,
  skillId: string,
): Promise<PersonaSkillLink> {
  return callJson<PersonaSkillLink>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/persona-skills`,
    { method: 'POST', body: JSON.stringify({ skillId }) },
  );
}

export async function removePersonaSkill(
  slug: string,
  skillId: string,
): Promise<void> {
  await callJson<void>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/persona-skills/${encodeURIComponent(skillId)}`,
    { method: 'DELETE' },
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

export interface SkillDetail extends SkillNode {
  usedByCount: number;
  /** Wave 8 — Agents that carry this skill as a direct-answer persona. */
  usedByAgentsCount: number;
}

export async function getSkill(id: string): Promise<SkillDetail> {
  return callJson<SkillDetail>(`/v1/operator/skills/${encodeURIComponent(id)}`);
}

export type ImportOutcome = 'created' | 'updated' | 'unchanged';

export interface ImportSkillInput {
  /** Raw SKILL.md text (paste or uploaded file content). */
  raw: string;
  /** Optional provenance path (e.g. the original file name). */
  sourcePath?: string;
  /** When true, compute the outcome + preview without persisting. */
  dryRun?: boolean;
}

export type SkillRiskCode =
  | 'instruction_override'
  | 'system_prompt_reference'
  | 'tool_coercion'
  | 'data_exfiltration'
  | 'hidden_content'
  | 'credential_harvest'
  | 'silent_permission_escalation';

export interface SkillRisk {
  code: SkillRiskCode;
  severity: 'warn';
  excerpt: string;
}

export interface SkillImportResult {
  outcome: ImportOutcome;
  skill: {
    slug: string;
    name: string;
    description: string | null;
    body: string;
    frontmatter: Record<string, unknown>;
    sourcePath: string | null;
  };
  contentHash: string;
  risks: SkillRisk[];
  resourceCount: number;
  skillId?: string;
  /**
   * OM-25 — the security verdict the import just produced.
   *
   * The server computed this all along and threw it away, so a skill that
   * landed in the registry as "⚠ MARKIERT — PRÜFUNG EMPFOHLEN" was confirmed to
   * the user as a plain success and the flag was discovered only by chance.
   *
   * NOT derivable from `risks`: that array cannot express `too_large_to_scan`
   * or `scan_failed`, and re-implementing `computeVerdict`'s thresholds
   * client-side would guarantee drift. Optional so a pre-OM-25 middleware still
   * type-checks.
   */
  verdict?: {
    severity: SkillVerdictSeverity;
    riskCodes: string[];
  };
  /**
   * Frontmatter lines the import had to drop: omadia's frontmatter is flat
   * `key: scalar`, so lists and nested maps (common in skills authored for
   * other ecosystems) cannot be represented. Reporting them keeps a truncated
   * import visible instead of letting the skill quietly lose data. Optional so
   * a middleware predating this field still type-checks.
   */
  unparsedFrontmatter?: string[];
}

export interface SkillResource {
  name: string;
  content?: string;
}

/** List a skill's bundled resource files. Names only by default (cheap). */
export async function listSkillResources(
  id: string,
  opts: { withContent?: boolean } = {},
): Promise<SkillResource[]> {
  const suffix = opts.withContent ? '' : '?names=1';
  const res = await callJson<{ resources: SkillResource[] }>(
    `/v1/operator/skills/${encodeURIComponent(id)}/resources${suffix}`,
  );
  return res.resources;
}

export async function importSkill(input: ImportSkillInput): Promise<SkillImportResult> {
  return callJson<SkillImportResult>('/v1/operator/skills/import', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Preview an import (dry-run) — computes outcome + normalized skill, no write. */
export async function previewImportSkill(
  input: Omit<ImportSkillInput, 'dryRun'>,
): Promise<SkillImportResult> {
  return importSkill({ ...input, dryRun: true });
}

/**
 * Fork an imported (source:'file') skill into an editable db copy — used by the
 * editor on first edit so provenance is preserved. Returns the fork (db) skill.
 */
export async function forkSkill(id: string): Promise<SkillNode> {
  return callJson<SkillNode>(`/v1/operator/skills/${encodeURIComponent(id)}/fork`, {
    method: 'POST',
  });
}

/**
 * Acknowledge/suppress a skill's current verdict (issue #436). Scoped to the
 * skill's CURRENT content_hash + verifier_version server-side — editing the
 * skill's content invalidates the ack automatically, it never carries over.
 */
export async function acknowledgeSkillVerdict(id: string): Promise<SkillVerdict> {
  return callJson<SkillVerdict>(`/v1/operator/skills/${encodeURIComponent(id)}/verdict/ack`, {
    method: 'POST',
  });
}

/**
 * Explicit-trigger only (issue #436 Phase 1b) — an LLM call is a real cost,
 * so this never fires automatically; the operator asks for it. Returns just
 * the LLM sub-result — callers should re-fetch the skill via `getSkill()` to
 * pick up the recombined (deterministic ⊕ LLM) severity.
 */
export async function triggerSkillVerdictLlmScan(
  id: string,
): Promise<{ llm: { severity: SkillVerdictSeverity; rationale: string | null; computedAt: string } }> {
  return callJson(`/v1/operator/skills/${encodeURIComponent(id)}/verdict/llm-scan`, {
    method: 'POST',
  });
}

/** One row of the read-only MCP grant matrix (issue #461). */
export interface McpGrantMatrixRow {
  grantId: string;
  holderKind: 'agent' | 'subagent' | 'skill' | 'plugin';
  agentSlug: string | null;
  agentName: string | null;
  subAgentId: string | null;
  subAgentName: string | null;
  serverId: string | null;
  serverName: string | null;
  toolName: string;
  severity: SkillVerdictSeverity | null;
  notYetScanned: boolean;
  acked: boolean;
  blocked: boolean;
  /** Issue #862 — the granted server's per-SERVER delegation mode (`null`
   *  when the row has no server); absent on older middleware. */
  delegation?: McpDelegation | null;
  /** Issue #862 — last verdict-epoch bump of this grant; `null` until the
   *  first bump (always `null` on skill-binding / plugin rows); absent on
   *  older middleware. */
  grantEpoch?: string | null;
}

/** One MCP call audit entry (issue #462). No tool arguments by design. */
export interface McpCallLogEntry {
  id: string;
  serverId: string | null;
  serverName: string;
  toolName: string;
  /** W2-3 (#542) — `api_key` is a call that arrived over the public MCP
   *  endpoint from a third party holding an API key: no orchestrator turn, no
   *  sub-agent, no plugin. Migration 0033 widened the matching DB CHECK. */
  callerKind: 'agent' | 'subagent' | 'skill' | 'plugin' | 'unattributed' | 'api_key';
  callerAgent: string | null;
  turnId: string | null;
  ok: boolean;
  error: string | null;
  durationMs: number;
  calledAt: string;
  /**
   * W0-1 — WHOSE authority the call acted under. `callerAgent` names the
   * orchestrator; this names the identity its credentials belonged to
   * (`apikey:<id>` for a public MCP call, an MCP user key otherwise). The
   * literal `unresolved` marks a call that had no identity to act as.
   *
   * The backend has returned this since the `mcp_call_log.acting_identity`
   * column landed; it was simply never surfaced, which left "whose credentials
   * touched that server?" unanswerable in the UI — the exact question the
   * column was added to answer.
   */
  actingIdentity: string | null;
}

export async function listMcpGrants(): Promise<{ grants: McpGrantMatrixRow[] }> {
  return callJson('/v1/operator/mcp-grants');
}

export interface McpOrchestrator {
  id: string;
  slug: string;
  name: string;
}

export async function listMcpOrchestrators(): Promise<{ orchestrators: McpOrchestrator[] }> {
  return callJson('/v1/operator/mcp-orchestrators');
}

/** Grant one server tool to an orchestrator from the Control Center (W8).
 *  Same fail-closed verdict gate as the Builder canvas. */
export async function grantMcpToolToOrchestrator(
  agentSlug: string,
  mcpServerId: string,
  toolName: string,
): Promise<void> {
  await callJson('/v1/operator/mcp-grants', {
    method: 'PUT',
    body: JSON.stringify({ agentSlug, mcpServerId, toolName }),
  });
}

/**
 * Result of an allowlist replace via `PUT /mcp-grants` with `toolNames[]`
 * (issue #862). `delegationScope` is always `'server'`: delegation lives on
 * `mcp_servers`, not per assignment, so a `delegation` sent with the edit
 * changed the SERVER's mode — for every agent holding a grant on it.
 */
export interface McpToolAllowlistResult {
  agentSlug: string;
  mcpServerId: string;
  /** The full allowlist after the edit (normalized tool names, sorted). */
  toolNames: string[];
  /** Tools this edit newly granted. */
  granted: string[];
  /** Tools this edit revoked (fell off the list). */
  revoked: string[];
  /** The server's delegation mode after the edit. */
  delegation: McpDelegation;
  delegationScope: 'server';
}

/**
 * Replace an agent's whole tool allowlist for one MCP server (issue #862).
 * The allowlist IS the set of `agent_tool_grants` rows for the (agent,
 * server) pair — tools missing from `toolNames` are revoked, new ones pass
 * the same fail-closed verdict gate as a single grant (one rejection aborts
 * the whole edit; nothing is written).
 *
 * `delegation` optionally sets the SERVER's delegation mode in the same
 * call — a per-server switch with global effect, see
 * {@link McpToolAllowlistResult.delegationScope}.
 */
export async function replaceMcpToolAllowlist(
  agentSlug: string,
  mcpServerId: string,
  toolNames: string[],
  opts?: { delegation?: McpDelegation },
): Promise<McpToolAllowlistResult> {
  return callJson<McpToolAllowlistResult>('/v1/operator/mcp-grants', {
    method: 'PUT',
    body: JSON.stringify({
      agentSlug,
      mcpServerId,
      toolNames,
      ...(opts?.delegation !== undefined ? { delegation: opts.delegation } : {}),
    }),
  });
}

/**
 * Machine codes the agent-builder grant routes emit as `{ error: '<code>' }`
 * (they predate the `{ code }` envelope `ApiError.code` parses, so the code
 * must be read from the body).
 *
 * i18n HARD RULE: these are NOT user-facing text. Pages map each code to a
 * message-catalogue key and render the localized copy; the raw body string
 * must never reach the UI.
 */
export const MCP_GRANT_ERROR_CODES = [
  // PUT /mcp-grants — the verdict gate (`assertMcpToolAllowed`) rejects
  // blocked / unscanned tools as a 409 `config_validation`.
  'config_validation',
  'invalid_delegation',
  'invalid_grant',
  'mcp_server_not_found',
  'multi_orchestrator_unavailable',
  'orchestrator_not_found',
  // DELETE /mcp-grants/:grantId
  'grant_not_found',
  'invalid_grant_id',
  'not_an_mcp_grant',
] as const;

export type McpGrantErrorCode = (typeof MCP_GRANT_ERROR_CODES)[number];

const MCP_GRANT_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  MCP_GRANT_ERROR_CODES,
);

/**
 * Extract the machine code from a failed grant/allowlist call, or `null`
 * when the error is not an {@link ApiError}, its body is not JSON, or the
 * code is not one this client knows. Total by construction — a proxy's HTML
 * 502 page yields `null`, never a throw.
 */
export function parseMcpGrantErrorCode(err: unknown): McpGrantErrorCode | null {
  if (!(err instanceof ApiError)) return null;
  try {
    const parsed = JSON.parse(err.body) as { error?: unknown };
    return typeof parsed.error === 'string' &&
      MCP_GRANT_ERROR_CODE_SET.has(parsed.error)
      ? (parsed.error as McpGrantErrorCode)
      : null;
  } catch {
    return null;
  }
}

export async function revokeMcpGrant(grantId: string): Promise<void> {
  await callJson(`/v1/operator/mcp-grants/${encodeURIComponent(grantId)}`, { method: 'DELETE' });
}

// ── Plugin MCP grants (issue #458 UX / W7) ───────────────────────────────────

export interface McpPluginCandidate {
  pluginId: string;
  name: string;
  serversHint: string[];
  grantedServerIds: string[];
}

export async function listMcpPluginCandidates(): Promise<{
  servers: { id: string; name: string; status: 'enabled' | 'disabled' }[];
  plugins: McpPluginCandidate[];
}> {
  return callJson('/v1/operator/mcp-plugin-candidates');
}

export async function grantPluginMcpServer(pluginId: string, mcpServerId: string): Promise<void> {
  await callJson('/v1/operator/plugin-mcp-grants', {
    method: 'PUT',
    body: JSON.stringify({ pluginId, mcpServerId }),
  });
}

export async function revokePluginMcpServer(pluginId: string, mcpServerId: string): Promise<void> {
  await callJson('/v1/operator/plugin-mcp-grants', {
    method: 'DELETE',
    body: JSON.stringify({ pluginId, mcpServerId }),
  });
}

/** Test-call sandbox (issue #463): guarded + audited like runtime dispatch. */
export async function testCallMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ result: string; ok: boolean; durationMs: number }> {
  return callJson(
    `/v1/operator/mcp-servers/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(toolName)}/test-call`,
    { method: 'POST', body: JSON.stringify({ args }) },
  );
}

/** Bulk re-discover + re-scan of every enabled server (issue #463). */
export async function rescanAllMcpServers(): Promise<{
  scannedServers: number;
  scannedTools: number;
  failures: { serverId: string; serverName: string; error: string }[];
}> {
  return callJson('/v1/operator/mcp-servers/rescan-all', { method: 'POST' });
}

export async function listMcpCallLog(opts?: {
  limit?: number;
  serverId?: string;
  beforeId?: string;
}): Promise<{ entries: McpCallLogEntry[] }> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.serverId) params.set('serverId', opts.serverId);
  if (opts?.beforeId) params.set('beforeId', opts.beforeId);
  const qs = params.toString();
  return callJson(`/v1/operator/mcp-call-log${qs ? `?${qs}` : ''}`);
}

// ── Skill capability bindings (issue #456) ───────────────────────────────────

export interface SkillContractBinding {
  contract: string;
  description: string | null;
  binding: {
    mcpServerId: string;
    serverName: string | null;
    toolName: string;
    boundBy: string;
    boundAt: string;
  } | null;
}

export async function listSkillToolBindings(
  skillId: string,
): Promise<{ contracts: SkillContractBinding[] }> {
  return callJson(`/v1/operator/skills/${encodeURIComponent(skillId)}/tool-bindings`);
}

/** Bind-time gate applies server-side: the tool must be scanned, and
 *  not-scanned-clean severities need an ack first. */
export async function bindSkillContract(
  skillId: string,
  contract: string,
  input: { mcpServerId: string; toolName: string },
): Promise<void> {
  await callJson(
    `/v1/operator/skills/${encodeURIComponent(skillId)}/tool-bindings/${encodeURIComponent(contract)}`,
    { method: 'PUT', body: JSON.stringify(input) },
  );
}

export async function unbindSkillContract(skillId: string, contract: string): Promise<void> {
  await callJson(
    `/v1/operator/skills/${encodeURIComponent(skillId)}/tool-bindings/${encodeURIComponent(contract)}`,
    { method: 'DELETE' },
  );
}

// ── MCP marketplace (issue #455) ─────────────────────────────────────────────

export interface McpRegistryInfo {
  id: string;
  name: string;
  url: string;
  authKind: 'none' | 'bearer';
  hasToken: boolean;
}

/** Where a search result actually came from. `cached-page` means the registry's
 *  own search was unavailable and the middleware substring-filtered the browse
 *  page it already held — correct, but limited to that page. */
export type McpCatalogScope = 'registry' | 'cached-page';

export interface McpCatalogEntry {
  id: string;
  name: string;
  description: string | null;
  version: string | null;
  transport: McpTransport | null;
  /** Issue #541 — the catalog only offered a deprecated (HTTP+SSE) remote. */
  transportDeprecated?: boolean;
  endpoint: string | null;
  license: string | null;
  author: string | null;
  sourceUrl: string | null;
}

export async function listMcpRegistries(): Promise<{ registries: McpRegistryInfo[] }> {
  return callJson('/v1/operator/mcp-registries');
}

export async function addMcpRegistry(input: {
  name: string;
  url: string;
  authKind?: 'none' | 'bearer';
  token?: string;
}): Promise<McpRegistryInfo> {
  return callJson('/v1/operator/mcp-registries', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function deleteMcpRegistry(id: string): Promise<void> {
  await callJson(`/v1/operator/mcp-registries/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * @param opts.refresh Operator explicitly asked to re-dial — drops the
 *   server-side success cache AND the short "recently unreachable" note.
 * @param opts.signal Abort a superseded request (search-as-you-type, or the
 *   operator switching registries) instead of leaving it in flight against a
 *   registry that can take the full timeout to fail.
 */
export async function searchMcpCatalog(
  registryId: string,
  q: string,
  opts?: { refresh?: boolean; signal?: AbortSignal },
): Promise<{ entries: McpCatalogEntry[]; scope?: McpCatalogScope }> {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (opts?.refresh === true) params.set('refresh', '1');
  const qs = params.toString();
  return callJson(
    `/v1/operator/mcp-registries/${encodeURIComponent(registryId)}/catalog${qs ? `?${qs}` : ''}`,
    opts?.signal ? { signal: opts.signal } : {},
  );
}

/** Gated import: the created server arrives DISABLED with provenance; the
 *  operator runs Discover (scan) and enables explicitly. */
export async function importMcpServerFromRegistry(
  registryId: string,
  catalogEntryId: string,
): Promise<McpServerNode> {
  return callJson('/v1/operator/mcp-servers/from-registry', {
    method: 'POST',
    body: JSON.stringify({ registryId, catalogEntryId }),
  });
}

// ── Generic MCP OAuth (issue #459 W9) ────────────────────────────────────────

/** Whose authority MCP calls to a server act under (W0-1). `per_user` requires
 *  each caller to have its own identity and fails closed without one;
 *  `service` is the explicit opt-in to one shared identity. */
export type McpDelegation = 'per_user' | 'service';

export interface McpAuthStatus {
  protected: boolean;
  connected: boolean;
  issuer: string | null;
  issuerHost?: string | null;
  /** A client can be acquired with no operator setup — via a Client ID Metadata
   *  Document (W2-4) or working Dynamic Client Registration. */
  brokered?: boolean;
  /** W2-4 — which link of the client-acquisition chain this issuer resolves
   *  through. `manual` is the permanent, supported Entra ID / Okta path, NOT a
   *  failure state: neither IdP supports CIMD. */
  acquisitionMode?: 'stored' | 'cimd' | 'dcr' | 'manual';
  /** W2-4 — the authorization server advertised
   *  `client_id_metadata_document_supported`. Independent of whether THIS install
   *  can serve the document (that needs inbound https reachability). */
  cimdSupported?: boolean;
  /** W2-4 — why CIMD is unavailable although the AS supports it. Almost always
   *  because this deployment is not inbound-reachable, which is normal on-prem. */
  cimdBlockedReason?: string | null;
  needsClient: boolean;
  redirectUri?: string;
  /** W0-1 — the server's delegation mode. */
  delegation?: McpDelegation;
  /** W0-1 — whether this session has an identity to act as. False on a
   *  `per_user` server means every call fails closed until an identity is
   *  available or the operator opts into `service` delegation. */
  identityResolved?: boolean;
}

/** Switch a server's delegation mode (W0-1). */
export async function setMcpServerDelegation(
  serverId: string,
  delegation: McpDelegation,
): Promise<{ id: string; delegation: McpDelegation }> {
  return callJson(`/v1/operator/mcp-servers/${encodeURIComponent(serverId)}/delegation`, {
    method: 'PUT',
    body: JSON.stringify({ delegation }),
  });
}

export async function getMcpAuthStatus(serverId: string): Promise<McpAuthStatus> {
  return callJson(`/v1/operator/mcp-servers/${encodeURIComponent(serverId)}/auth-status`);
}

/** Begin the OAuth flow. Returns the authorize URL, or a needs-client marker
 *  (409) when the issuer must be registered once first. */
export async function authorizeMcpServer(
  serverId: string,
): Promise<{ authorizeUrl?: string; needsClient?: boolean; issuer?: string | null }> {
  try {
    return await callJson(`/v1/operator/mcp-servers/${encodeURIComponent(serverId)}/authorize`, {
      method: 'POST',
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      let issuer: string | null = null;
      try {
        issuer = (JSON.parse(err.body) as { issuer?: string }).issuer ?? null;
      } catch {
        /* keep null */
      }
      return { needsClient: true, issuer };
    }
    throw err;
  }
}

export async function setMcpOAuthClient(
  issuer: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  await callJson('/v1/operator/mcp-oauth-clients', {
    method: 'PUT',
    body: JSON.stringify({ issuer, clientId, clientSecret: clientSecret || undefined }),
  });
}

export async function disconnectMcpServer(serverId: string): Promise<void> {
  await callJson(`/v1/operator/mcp-servers/${encodeURIComponent(serverId)}/token`, {
    method: 'DELETE',
  });
}

/** Enable/disable a server (issue #460). Triggers a registry reload server-side. */
export async function setMcpServerStatus(
  id: string,
  status: 'enabled' | 'disabled',
): Promise<McpServerNode> {
  return callJson<McpServerNode>(`/v1/operator/mcp-servers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

/** Toggle Privacy Shield bypass for a server (epic #459): its tool results are
 *  returned unmasked. Triggers a registry reload so the change takes effect. */
export async function setMcpServerPrivacyBypass(
  id: string,
  privacyBypass: boolean,
): Promise<McpServerNode> {
  return callJson<McpServerNode>(`/v1/operator/mcp-servers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ privacyBypass }),
  });
}

/** Toggle Knowledge-Graph ingestion for a server (epic #459): successful tool
 *  results are written as recallable observations (masked digest, or raw when
 *  the server is also privacy-bypassed). */
export async function setMcpServerKgIngest(
  id: string,
  kgIngest: boolean,
): Promise<McpServerNode> {
  return callJson<McpServerNode>(`/v1/operator/mcp-servers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ kgIngest }),
  });
}

/**
 * Acknowledge a high_risk MCP tool verdict (issue #454). Server-side the ack
 * pins the verdict's current content hash — a re-discover that changes the
 * tool's content invalidates it, mirroring the skill-side ack semantics.
 */
export async function ackMcpToolVerdict(
  serverId: string,
  toolName: string,
): Promise<{ severity: SkillVerdictSeverity; acked: boolean; ackedBy: string; ackedAt: string }> {
  return callJson(
    `/v1/operator/mcp-servers/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(toolName)}/verdict/ack`,
    { method: 'POST' },
  );
}

/** Export a skill back to portable SKILL.md text (frontmatter + body). */
export async function exportSkill(id: string): Promise<string> {
  const res = await fetch(botApi(`/v1/operator/skills/${encodeURIComponent(id)}/export`), {
    headers: { accept: 'text/markdown' },
    cache: 'no-store',
    credentials: 'include',
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, `export ${id} failed: ${res.status}`, text);
  return text;
}

// -----------------------------------------------------------------------------
// Public MCP key bindings (W5-1)
// -----------------------------------------------------------------------------

/**
 * A row of `public_mcp_key_bindings` — the per-API-key allowlist behind the
 * public MCP endpoint. `enabled: false` is a PARKED binding: the key reaches
 * nothing, but what it was configured to reach is still on the row.
 */
/** #571 — a non-fatal note that a binding points at an id that does not
 *  resolve, so it reaches nothing despite looking configured. `code` is the
 *  stable, locale-independent discriminator the pane renders from; `message` is
 *  the server's English fallback, for API consumers and logs. */
export interface PublicMcpKeyBindingWarning {
  code: 'key_id_unknown' | 'agent_id_unknown';
  message: string;
}

export interface PublicMcpKeyBinding {
  keyId: string;
  agentId: string;
  readTools: string[];
  writeTools: string[];
  writeRateLimitPerMinute: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** #571 — present only when the key or agent this row names does not resolve.
   *  Absent on a clean row, so a healthy binding is unchanged from before. */
  warnings?: PublicMcpKeyBindingWarning[];
}

export interface PublicMcpKeyBindingsResponse {
  bindings: PublicMcpKeyBinding[];
}

export interface UpsertPublicMcpKeyBindingInput {
  keyId: string;
  agentId: string;
  readTools: string[];
  writeTools: string[];
  writeRateLimitPerMinute?: number;
  /** OMIT to leave the revoked/active state exactly as stored. Sending `true`
   *  RE-ARMS a revoked key, so this pane never sends it implicitly — un-parking
   *  goes through `restorePublicMcpKeyBinding` instead. */
  enabled?: boolean;
}

export async function listPublicMcpKeyBindings(): Promise<PublicMcpKeyBindingsResponse> {
  return callJson<PublicMcpKeyBindingsResponse>('/v1/operator/public-mcp-bindings');
}

export async function upsertPublicMcpKeyBinding(
  input: UpsertPublicMcpKeyBindingInput,
): Promise<{ binding: PublicMcpKeyBinding }> {
  return callJson<{ binding: PublicMcpKeyBinding }>('/v1/operator/public-mcp-bindings', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Parks the binding. Deliberately not a delete — the configured reach stays
 *  visible so an operator can see what the integration used to have. */
export async function revokePublicMcpKeyBinding(
  keyId: string,
): Promise<{ binding: PublicMcpKeyBinding }> {
  return callJson<{ binding: PublicMcpKeyBinding }>(
    `/v1/operator/public-mcp-bindings/${encodeURIComponent(keyId)}/revoke`,
    { method: 'POST' },
  );
}

/** Un-parks a revoked binding, restoring the reach it already had on the row.
 *  Its own call, not a side effect of saving: a save that never mentions
 *  `enabled` deliberately CANNOT re-arm a key an operator revoked. */
export async function restorePublicMcpKeyBinding(
  keyId: string,
): Promise<{ binding: PublicMcpKeyBinding }> {
  return callJson<{ binding: PublicMcpKeyBinding }>(
    `/v1/operator/public-mcp-bindings/${encodeURIComponent(keyId)}/restore`,
    { method: 'POST' },
  );
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
  | 'schedule';

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
