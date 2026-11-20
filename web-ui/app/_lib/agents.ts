import { parseOperatorArchetypes, type OperatorArchetypeDto } from './archetypes';
import { ApiError, rscTimeoutSignal } from './api';
import type { LocalizedMarkdown } from './storeTypes';
import type { TeamsTargetKind } from './teamsInstallTarget';

/**
 * Typed client for the operator multi-orchestrator REST surface
 * (`/api/v1/operator/agents/*` — see `routes/operatorAgents.ts` in the
 * middleware). Used by `app/operator/agents/(index)/page.tsx` (RSC fetches) and
 * the client-side dashboard component (writes).
 *
 * `botApi` + `forwardCookieHeader` are inlined here because `_lib/api.ts`
 * keeps them as file-private helpers (exporting them would mean touching
 * an unrelated file and changing its public surface mid-feature). The
 * logic is verbatim from api.ts; keep the two in sync if the cookie /
 * URL conventions ever change.
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

export type PrivacyProfile = 'strict' | 'default';
export type AgentStatus = 'enabled' | 'disabled';
/** #2088 — the archetype of an agent: `standard`, or one an archetype plugin
 *  registered (today `facilitator`). Fixed at creation, never switched. */
export type AgentArchetype = string;
export const STANDARD_ARCHETYPE: AgentArchetype = 'standard';
export const FACILITATOR_ARCHETYPE: AgentArchetype = 'facilitator';

/** What an agent DTO says about its archetype. */
export interface ArchetypeBearer {
  archetype?: AgentArchetype;
}

/** The archetype of an agent; an agent without one is a standard agent. */
export function archetypeOfAgent(agent: ArchetypeBearer): AgentArchetype {
  return agent.archetype ?? STANDARD_ARCHETYPE;
}

export interface OperatorAgentPluginDto {
  id: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

export interface OperatorAgentBindingDto {
  channel_type: string;
  channel_key: string;
}

export interface OperatorAgentDto {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  /** Reserved, not enforced (#978): persisted and reported, read by no
   *  runtime path — `strict` behaves like `default`. */
  privacy_profile: PrivacyProfile;
  status: AgentStatus;
  /** #2088 — absent on a middleware that predates archetypes; read it
   *  through `archetypeOfAgent` / `isFacilitatorAgent`. */
  archetype?: AgentArchetype;
  created_at: string;
  updated_at: string;
  active: boolean;
  memory_scope: string[];
  plugins: OperatorAgentPluginDto[];
  bindings: OperatorAgentBindingDto[];
  /** #1033 — the model the registry currently runs this agent on; `null`
   *  until built. Absent on a pre-W4 middleware. */
  effective_model?: string | null;
  /** #1033 — the agent's model policy. Absent on a pre-W4 middleware. */
  model_policy?: ModelPolicy;
}

export interface OperatorAgentsListDto {
  agents: OperatorAgentDto[];
  /** #2055 — the agent of the instance entry of the default-agent table
   *  (`null` = off): who answers an unaddressed message when no user or
   *  channel entry applies. */
  default_agent_id: string | null;
}

export async function callJson<T>(
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
    // OM-96 — a server-side GET read gates the RSC payload of the page that
    // awaits it. Without a deadline, a middleware endpoint that accepts the
    // connection and never answers parks the navigation instead of failing a
    // single card. Mutations are left unbounded on purpose: only the caller
    // knows whether abandoning a half-applied write is safe.
    signal: (init?.method ?? 'GET') === 'GET' ? rscTimeoutSignal(init) : init?.signal,
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

export async function listOperatorAgents(): Promise<OperatorAgentsListDto> {
  return callJson<OperatorAgentsListDto>('/v1/operator/agents');
}

/**
 * #2088 — the archetypes agents can be created of. `null` when the
 * middleware does not have the endpoint (it predates it) or does not answer:
 * the directory then shows what it always showed.
 */
export async function listOperatorArchetypes(): Promise<OperatorArchetypeDto[] | null> {
  try {
    return parseOperatorArchetypes(await callJson<unknown>('/v1/operator/archetypes'));
  } catch {
    return null;
  }
}

/** Dashboard MCP health summary (epic #459): how many servers are registered,
 *  how many are enabled, how many discovered tools they expose, and how many
 *  enabled servers still need a Discover run. Best-effort — a rejection just
 *  degrades the one card. */
export interface McpServerSummary {
  total: number;
  enabled: number;
  tools: number;
  needsDiscovery: number;
}

export async function getMcpServerSummary(): Promise<McpServerSummary> {
  const { servers } = await callJson<{
    servers: Array<{ status?: string; discoveredTools?: unknown[] }>;
  }>('/v1/operator/mcp-servers');
  const list = servers ?? [];
  const toolCount = (s: { discoveredTools?: unknown[] }): number =>
    Array.isArray(s.discoveredTools) ? s.discoveredTools.length : 0;
  const enabled = list.filter((s) => s.status === 'enabled');
  return {
    total: list.length,
    enabled: enabled.length,
    tools: list.reduce((n, s) => n + toolCount(s), 0),
    needsDiscovery: enabled.filter((s) => toolCount(s) === 0).length,
  };
}

export interface CreateAgentInput {
  slug: string;
  name: string;
  description?: string;
  /** Reserved, not enforced (#978): persisted and reported, read by no
   *  runtime path — `strict` behaves like `default`. */
  privacy_profile?: PrivacyProfile;
  status?: AgentStatus;
  /** #2088 — only on create. Omitted = `standard`. */
  archetype?: AgentArchetype;
}

/** A facilitator only moderates (spec 2043 §2). */
export function isFacilitatorAgent(agent: ArchetypeBearer): boolean {
  return archetypeOfAgent(agent) === FACILITATOR_ARCHETYPE;
}

export async function createOperatorAgent(input: CreateAgentInput): Promise<{
  id: string;
  slug: string;
  archetype?: AgentArchetype;
}> {
  return callJson('/v1/operator/agents', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export interface PatchAgentInput {
  name?: string;
  description?: string | null;
  /** Reserved, not enforced (#978): persisted and reported, read by no
   *  runtime path — `strict` behaves like `default`. */
  privacy_profile?: PrivacyProfile;
  status?: AgentStatus;
}

/**
 * #2088 — what ended with an agent when it was disabled or deleted (end of
 * service). `process_outcome`: `ended` = its archetype plugin closed its
 * processes; `not_supported` = the archetype has none to close (or no plugin
 * that could); `failed` = the plugin did not answer, the kernel ended the
 * agent's message subscriptions anyway.
 */
export interface EndOfServiceDto {
  reason: 'agent_disabled' | 'agent_deleted' | 'archetype_plugin_removed';
  process_outcome: 'ended' | 'not_supported' | 'failed';
  process_detail?: string;
  processes: Array<{
    process_id: string;
    channel_type: string;
    conversation_id: string;
    outcome: 'aborted' | 'failed';
    report_posted?: boolean;
    detail?: string;
  }>;
  subscriptions_ended: Array<{ channel_type: string; conversation_id: string }>;
  /** #2090 — execution scopes the kernel ended, and conversations whose
   *  reservation it released. Absent on an older middleware. */
  execution_scopes_ended?: number;
  reservations_released?: { channel_type: string; conversation_id: string }[];
  system_notices_owed: number;
}

/** #2088 — a deleted agent: its record is kept until an operator purges it. */
export interface DeletedAgentDto {
  id: string;
  slug: string;
  name: string;
  archetype: string;
  deleted_at: string;
  deleted_by: string | null;
  purgeable_from: string;
  purgeable_without_confirmation: boolean;
}

export interface AgentChangeResult {
  ok: boolean;
  end_of_service?: EndOfServiceDto;
  tombstone?: DeletedAgentDto;
}

export async function patchOperatorAgent(
  slug: string,
  patch: PatchAgentInput,
): Promise<AgentChangeResult> {
  return callJson<AgentChangeResult>(`/v1/operator/agents/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/** Deletes an agent: it goes out of service and its record is kept as a
 *  deleted agent (#2088). `purgeDeletedAgent` removes it for good. */
export async function deleteOperatorAgent(slug: string): Promise<AgentChangeResult> {
  return callJson<AgentChangeResult>(`/v1/operator/agents/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
  });
}

export async function listDeletedAgents(): Promise<{ retention_days: number; agents: DeletedAgentDto[] }> {
  return callJson('/v1/operator/agents/deleted');
}

/** `confirm`: the agent's slug, required while it was deleted less than the
 *  retention period ago (409 `purge_confirmation_required` otherwise). */
export async function purgeDeletedAgent(id: string, confirm?: string): Promise<{ ok: boolean }> {
  return callJson(`/v1/operator/agents/deleted/${encodeURIComponent(id)}/purge`, {
    method: 'POST',
    body: JSON.stringify(confirm !== undefined ? { confirm } : {}),
  });
}

// ── #2090 — execution scopes of archetype plugins and the kill switch ───

export type ExecutionScopeKind = 'configuring' | 'active' | 'closing' | 'scheduling' | 'follow_up';
export type KillSwitchLevel = 'instance' | 'agent' | 'process';

export interface ExecutionScopeDto {
  id: string;
  agent_slug: string;
  plugin_id: string;
  process_id: string;
  kind: ExecutionScopeKind;
  event_id: string | null;
  deadline: string;
  absolute_limit: string;
  deadline_wait: boolean;
  budget: { actions: number; model_calls: number };
  used: { actions: number; model_calls: number };
  conversations: number;
  people: number;
  opened_at: string;
  /** A set kill switch reaches this scope: nothing is authorized under it. */
  stopped: boolean;
}

export interface KillSwitchDto {
  id: string;
  level: KillSwitchLevel;
  agent_slug: string | null;
  process_id: string | null;
  reason: string;
  set_by: string;
  set_at: string;
}

/** #2067 — a run agents started themselves (a discussion in a conversation).
 *  It holds no execution scope; its stop is final. */
export interface RunningDiscussionDto {
  workflow_id: string;
  slug: string;
  opened_by: string | null;
  participants: string[];
  topic: string | null;
  conversation: { channel_type: string; conversation_id: string } | null;
  status: string | null;
  started_at: string | null;
  /** A stop was requested and takes effect at the run's next step. */
  stop_requested_at: string | null;
  expires_at: string | null;
  /** A lookup failed: the row may show less than there is. */
  incomplete: boolean;
}

/** A conversation that is held right now: no other process or discussion
 *  starts there until it is released. */
export interface HeldReservationDto {
  id: string;
  channel_type: string;
  conversation_id: string;
  holder_kind: 'archetype_process' | 'agent_discussion';
  agent_slug: string | null;
  plugin_id: string | null;
  process_id: string;
  role: 'home' | 'session';
  reserved_at: string;
}

export interface ExecutionOverviewDto {
  kill_switches: KillSwitchDto[];
  scopes: ExecutionScopeDto[];
  discussions: RunningDiscussionDto[];
  /** The discussion listing failed; `discussions` is empty for that reason. */
  discussions_failed: boolean;
  /** Absent on a middleware that predates the listing. */
  reservations?: HeldReservationDto[];
}

export async function getExecutionOverview(): Promise<ExecutionOverviewDto> {
  return callJson('/v1/operator/execution');
}

/** Refuses every further action in the switch's reach until it is cleared.
 *  Ends nothing. */
export async function setKillSwitch(input: {
  level: KillSwitchLevel;
  agent_slug?: string;
  process_id?: string;
  reason?: string;
}): Promise<{ kill_switch: KillSwitchDto }> {
  return callJson('/v1/operator/execution/kill-switches', { method: 'POST', body: JSON.stringify(input) });
}

export async function clearKillSwitch(id: string): Promise<{ ok: boolean }> {
  return callJson(`/v1/operator/execution/kill-switches/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Frees a held conversation for the next process. Ends no process and no
 *  discussion. */
export async function releaseReservation(id: string): Promise<{ ok: boolean }> {
  return callJson(`/v1/operator/execution/reservations/${encodeURIComponent(id)}/release`, { method: 'POST' });
}

/** Cancels a running agent discussion and releases its conversation. Final. */
export async function stopDiscussion(workflowId: string): Promise<{ ok: boolean; cancelled_runs: number }> {
  return callJson(`/v1/operator/execution/discussions/${encodeURIComponent(workflowId)}/stop`, { method: 'POST' });
}

// ── W0c (#861) — per-agent plugin assignment + grant read model ─────────

export interface AgentPluginsDto {
  slug: string;
  plugins: OperatorAgentPluginDto[];
}

/**
 * Per-agent read of the plugin assignment (issue #861) — same row shape as
 * the `plugins` array on `GET /v1/operator/agents`, so the agent detail page
 * does not have to filter the full dashboard payload.
 */
export async function getAgentPlugins(slug: string): Promise<AgentPluginsDto> {
  return callJson<AgentPluginsDto>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/plugins`,
  );
}

export interface ToggleAgentPluginResponse {
  ok: boolean;
  plugin: { id: string; enabled: boolean };
}

/**
 * Enable/disable ONE plugin on an agent (issue #861). The plugin id travels
 * in the body, not the path: plugin ids contain `/` (`@omadia/odoo`), which
 * an Express path segment cannot carry without double-encoding. Server-side
 * the toggle preserves the row's existing per-agent config; disabling a
 * plugin that was never assigned yields a 404 with `error:
 * 'plugin_not_assigned'` (see {@link parseOperatorAgentErrorCode}).
 */
export async function toggleAgentPlugin(
  slug: string,
  pluginId: string,
  enabled: boolean,
): Promise<ToggleAgentPluginResponse> {
  return callJson<ToggleAgentPluginResponse>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/plugins`,
    { method: 'PATCH', body: JSON.stringify({ id: pluginId, enabled }) },
  );
}

// ── #1033 — per-agent model policy ──────────────────────────────────────

export const MODEL_POLICY_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type ModelPolicyEffort = (typeof MODEL_POLICY_EFFORTS)[number];

/** One explicit model choice: which provider, which model, optionally how hard. */
export interface ModelRef {
  provider: string;
  model: string;
  effort?: ModelPolicyEffort;
}

/**
 * `agents.model_policy` as the middleware persists it. `'auto'` is today's
 * resolution (`model_routing` → platform default); `'none'` is today's
 * failure behaviour (the turn dies once retries are spent).
 */
export interface ModelPolicy {
  primary: 'auto' | ModelRef;
  fallback: 'none' | 'auto' | ModelRef;
}

export const DEFAULT_MODEL_POLICY: ModelPolicy = { primary: 'auto', fallback: 'none' };

export function isModelRef(v: ModelPolicy['primary'] | ModelPolicy['fallback']): v is ModelRef {
  return typeof v === 'object' && v !== null;
}

function parseModelRef(raw: unknown): ModelRef | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.provider !== 'string' || typeof rec.model !== 'string') return undefined;
  const effort = rec.effort;
  return {
    provider: rec.provider,
    model: rec.model,
    ...(typeof effort === 'string' && (MODEL_POLICY_EFFORTS as readonly string[]).includes(effort)
      ? { effort: effort as ModelPolicyEffort }
      : {}),
  };
}

/**
 * Deny-default narrowing, mirroring the middleware's `parseModelPolicy`: a
 * shape this bundle does not understand renders as the default rather than
 * as a model the runtime would not actually use.
 */
export function parseModelPolicy(raw: unknown): ModelPolicy {
  if (raw === null || typeof raw !== 'object') return DEFAULT_MODEL_POLICY;
  const rec = raw as Record<string, unknown>;
  const primary = rec.primary === 'auto' ? 'auto' : parseModelRef(rec.primary);
  const fallback =
    rec.fallback === 'none' || rec.fallback === 'auto' ? rec.fallback : parseModelRef(rec.fallback);
  if (primary === undefined || fallback === undefined) return DEFAULT_MODEL_POLICY;
  return { primary, fallback };
}

export interface ModelPolicyDto {
  slug: string;
  policy: ModelPolicy;
  /** What `auto` currently resolves to (the registry's built model), or null. */
  effectiveModel: string | null;
  activeProvider: string | null;
  /** An explicit primary on another provider that the host cannot run there. */
  deferredProvider?: string;
  vision: { primary?: boolean | null; fallback?: boolean | null };
}

export async function getAgentModelPolicy(slug: string): Promise<ModelPolicyDto> {
  const res = await callJson<ModelPolicyDto>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/model-policy`,
  );
  return { ...res, policy: parseModelPolicy(res.policy) };
}

export interface SetModelPolicyResponse {
  ok: boolean;
  policy: ModelPolicy;
  vision: { primary?: boolean; fallback?: boolean };
  deferredProvider?: string;
}

/**
 * Dedicated endpoint, like context-memory: which model answers under an
 * agent's name is a cost / data-residency / quality decision that must not
 * ride along on a rename. A `ConfigValidationError` (unknown model, unkeyed
 * provider, undeclared effort, fallback = primary) surfaces as 409
 * `config_validation`.
 */
export async function setAgentModelPolicy(
  slug: string,
  policy: ModelPolicy,
): Promise<SetModelPolicyResponse> {
  const res = await callJson<SetModelPolicyResponse>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/model-policy`,
    { method: 'PUT', body: JSON.stringify(policy) },
  );
  return { ...res, policy: parseModelPolicy(res.policy) };
}

// ── #1018 — agent-to-agent switches ─────────────────────────────────────

export const AGENT_TO_AGENT_MODES = ['off', 'on'] as const;
export type AgentToAgentMode = (typeof AGENT_TO_AGENT_MODES)[number];

export function parseAgentToAgentMode(raw: unknown): AgentToAgentMode {
  return raw === 'on' ? 'on' : 'off';
}

export interface AgentToAgentDto {
  slug: string;
  mode: AgentToAgentMode;
  modes: readonly string[];
}

export async function getAgentAgentToAgent(slug: string): Promise<AgentToAgentDto> {
  const res = await callJson<AgentToAgentDto>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/agent-to-agent`,
  );
  return { ...res, mode: parseAgentToAgentMode(res.mode) };
}

export async function setAgentAgentToAgent(
  slug: string,
  mode: AgentToAgentMode,
): Promise<{ ok: boolean; mode: AgentToAgentMode }> {
  return callJson<{ ok: boolean; mode: AgentToAgentMode }>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/agent-to-agent`,
    { method: 'PUT', body: JSON.stringify({ mode }) },
  );
}

/** One `(channel, agent)` enablement row. */
export interface PeerChannelDto {
  channelType: string;
  channelKey: string;
  enabled: boolean;
  updatedAt: string;
}

/** One chat the agent's own bot is present in — what the picker offers. */
export interface PeerChatCandidateDto {
  channelType: string;
  channelKey: string;
  /** The chat's topic when the channel captured one; null otherwise. */
  label: string | null;
  /** Channel-specific chat kind (`groupChat`, `channel`, …); null if unknown. */
  kind: string | null;
  /** Human participants' display names (capped server-side). */
  members: string[];
  /** The other agents whose bots are present — possible partners. */
  partners: { slug: string; name: string }[];
}

export interface PeerChannelsDto {
  slug: string;
  mode: AgentToAgentMode;
  channels: PeerChannelDto[];
  /** Channel kinds this agent owns a bot on; empty = no provisioned bot. */
  channelTypes: string[];
  /** The chats those bots are actually in. Derived server-side, never typed. */
  available: PeerChatCandidateDto[];
}

interface PeerChannelsWire extends Omit<PeerChannelsDto, 'channelTypes' | 'available'> {
  channel_types?: unknown;
  available?: unknown;
}

function parsePeerChatCandidate(raw: unknown): PeerChatCandidateDto | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['channelType'] !== 'string' || typeof r['channelKey'] !== 'string') return null;
  const partners = Array.isArray(r['partners'])
    ? r['partners'].flatMap((p: unknown) => {
        if (typeof p !== 'object' || p === null) return [];
        const q = p as Record<string, unknown>;
        return typeof q['slug'] === 'string'
          ? [{ slug: q['slug'], name: typeof q['name'] === 'string' ? q['name'] : q['slug'] }]
          : [];
      })
    : [];
  return {
    channelType: r['channelType'],
    channelKey: r['channelKey'],
    label: typeof r['label'] === 'string' && r['label'].length > 0 ? r['label'] : null,
    kind: typeof r['kind'] === 'string' ? r['kind'] : null,
    members: Array.isArray(r['members']) ? r['members'].filter((m): m is string => typeof m === 'string') : [],
    partners,
  };
}

export async function getAgentPeerChannels(slug: string): Promise<PeerChannelsDto> {
  const res = await callJson<PeerChannelsWire>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/peer-channels`,
  );
  const { channel_types: types, available, ...rest } = res;
  return {
    ...rest,
    mode: parseAgentToAgentMode(res.mode),
    channelTypes: Array.isArray(types) ? types.filter((t): t is string => typeof t === 'string') : [],
    available: Array.isArray(available)
      ? available.map(parsePeerChatCandidate).filter((c): c is PeerChatCandidateDto => c !== null)
      : [],
  };
}

export async function setAgentPeerChannel(
  slug: string,
  channelType: string,
  channelKey: string,
  enabled: boolean,
): Promise<{ ok: boolean; channelType: string; channelKey: string; enabled: boolean }> {
  return callJson(
    `/v1/operator/agents/${encodeURIComponent(slug)}/peer-channels/${encodeURIComponent(channelType)}/${encodeURIComponent(channelKey)}`,
    { method: 'PUT', body: JSON.stringify({ enabled }) },
  );
}

export async function removeAgentPeerChannel(
  slug: string,
  channelType: string,
  channelKey: string,
): Promise<{ ok: boolean }> {
  return callJson<{ ok: boolean }>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/peer-channels/${encodeURIComponent(channelType)}/${encodeURIComponent(channelKey)}`,
    { method: 'DELETE' },
  );
}

// ── W5 memory-ACL rollout switch (#899) ────────────────────────────────

/**
 * The modes `agents.context_memory` accepts. Structural contract with
 * the middleware, same arrangement as {@link TEAMS_PROVISIONING_STATES}: the
 * column's CHECK constraint (migration 0050) owns the vocabulary, the route
 * re-states it, and this list mirrors it so the radio group renders without a
 * round trip. {@link ContextMemoryDto.modes} carries the server's own copy —
 * the component renders THAT and falls back to this list, so a middleware that
 * grows a fourth mode does not need a UI release to expose it.
 */
export const CONTEXT_MEMORY_MODES = [
  'off',
  'enforce',
  'enforce-strict',
  'members',
] as const;

export type ContextMemoryMode = (typeof CONTEXT_MEMORY_MODES)[number];

const CONTEXT_MEMORY_MODE_SET: ReadonlySet<string> = new Set(
  CONTEXT_MEMORY_MODES,
);

/**
 * Narrow an arbitrary string to a known mode, deny-default to `'off'`.
 *
 * Mirrors the server's `normalizeContextMemoryMode` and the orchestrator's
 * `parseContextMemoryMode`: the UI must never claim an agent is enforcing
 * when the runtime would route it as `off`. A security control that reads
 * "on" while behaving as "off" is worse than one that is plainly off.
 */
export function parseContextMemoryMode(raw: unknown): ContextMemoryMode {
  return typeof raw === 'string' && CONTEXT_MEMORY_MODE_SET.has(raw)
    ? (raw as ContextMemoryMode)
    : 'off';
}

export interface ContextMemoryDto {
  slug: string;
  mode: ContextMemoryMode;
  /** The union the SERVER accepts. Rendered in preference to the local
   *  constant so the control follows the middleware, not the bundle. */
  modes: readonly string[];
}

/** Read the W5 memory-ACL rollout mode of one agent (issue #899). */
export async function getAgentContextMemory(
  slug: string,
): Promise<ContextMemoryDto> {
  const res = await callJson<ContextMemoryDto>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/context-memory`,
  );
  return { ...res, mode: parseContextMemoryMode(res.mode) };
}

/**
 * Set the W5 memory-ACL rollout mode of one agent (issue #899).
 *
 * A dedicated endpoint rather than a field on `patchOperatorAgent`: that call
 * is the dashboard's rename/enable form and sends whatever it holds, so
 * folding a memory-scope change into it would let an unrelated edit carry one
 * along. The server reloads the registry, so the next turn is already scoped.
 */
export async function setAgentContextMemory(
  slug: string,
  mode: ContextMemoryMode,
): Promise<{ ok: boolean; mode: ContextMemoryMode }> {
  return callJson<{ ok: boolean; mode: ContextMemoryMode }>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/context-memory`,
    { method: 'PUT', body: JSON.stringify({ mode }) },
  );
}

/** One `agent_tool_grants` row of the per-agent grant read model (issue
 *  #861). Snake_case mirrors the REST payload verbatim, like the other
 *  operator-agents DTOs in this file. */
export interface AgentToolGrantRowDto {
  id: string;
  tool_kind: 'native' | 'mcp';
  /** For `tool_kind === 'mcp'` this is the BARE tool name: the middleware
   *  normalizes stored refs through `mcpToolNameFromRef` before serializing
   *  (a persisted ref may carry a legacy '<serverName>:' prefix). Safe to
   *  compare verbatim against `discoveredTools[].name`. */
  tool_ref: string;
  /** Set when a SUB-AGENT of this agent holds the grant (agent_tool_grants is
   *  a XOR table; the read model attributes sub-agent rows to the parent,
   *  like every graph read). The assignment editor must skip these rows —
   *  they are not part of the orchestrator's own top-level allowlist. */
  sub_agent_id: string | null;
  mcp_server_id: string | null;
  /** Joined-in display name; null for native tools or a deleted server. */
  server_name: string | null;
  /** Issue #861 — last verdict-epoch bump of this grant (`bumpMcpGrantEpoch`
   *  stamps `config.verdictEpoch`); null until the first bump touches the
   *  row. */
  grant_epoch: string | null;
  created_at: string;
}

/** One `plugin_mcp_grants` row of a plugin assigned to the agent (#861). */
export interface AgentPluginMcpGrantRowDto {
  plugin_id: string;
  mcp_server_id: string;
  server_name: string | null;
  granted_by: string;
  granted_at: string;
}

export interface AgentGrantsDto {
  slug: string;
  /** Latest verdict-epoch bump across the agent's tool grants; null when no
   *  grant has ever been bumped. Epochs are `now()::text` timestamps, so the
   *  lexicographic max the server computes IS the latest. */
  grant_epoch: string | null;
  tool_grants: AgentToolGrantRowDto[];
  plugin_mcp_grants: AgentPluginMcpGrantRowDto[];
}

/**
 * Per-agent grant read model (issue #861): the agent's `agent_tool_grants`
 * rows — held directly or by one of its sub-agents (`sub_agent_id` tells them
 * apart) — plus the `plugin_mcp_grants` of every plugin assigned to it, one
 * response for the agent detail page. Read-only — grant WRITES stay on the
 * agent-builder surface (`_lib/agentBuilder.ts`).
 */
export async function getAgentGrants(slug: string): Promise<AgentGrantsDto> {
  return callJson<AgentGrantsDto>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/grants`,
  );
}

/**
 * Machine codes the operator-agents plugin/grant routes emit as
 * `{ error: '<code>' }` (they predate the `{ code }` envelope; `ApiError.code`
 * falls back to `error` since #1333, this list is what limits the codes a page
 * may translate).
 *
 * i18n HARD RULE: these are NOT user-facing text. Pages map each code to a
 * message-catalogue key and render the localized copy; the raw body string
 * must never reach the UI. `parseOperatorAgentErrorCode` narrows to this
 * union so a page's mapping can be exhaustive with a typed fallback.
 */
export const OPERATOR_AGENT_ERROR_CODES = [
  'agent_graph_store_unavailable',
  'config_validation',
  'invalid_body',
  'invalid_slug',
  'multi_orchestrator_unavailable',
  'not_found',
  'plugin_not_assigned',
  // #1033 — the model-policy routes 503 with this while the catalogue is
  // not wired (no DATABASE_URL / orchestrator not active).
  'model_policy_unavailable',
  // #914 — the agent identity routes. Listed here rather than in a second
  // catalogue so one page needs one mapping: the identity section renders
  // `detailErrors.<code>` exactly like every other operator-agents surface.
  'agent_identity_unavailable',
  'invalid_avatar',
  'payload_too_large',
  'unsupported_media_type',
  // Spec 2042 §5.11 — `PUT …/context-memory` refuses `off` for an agent that
  // holds capability grants.
  'context_memory_required',
] as const;

export type OperatorAgentErrorCode = (typeof OPERATOR_AGENT_ERROR_CODES)[number];

const OPERATOR_AGENT_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  OPERATOR_AGENT_ERROR_CODES,
);

/**
 * Extract the machine code from a failed operator-agents call, or `null`
 * when the error is not an {@link ApiError}, its body is not JSON, or the
 * code is not one this client knows. Total by construction — a proxy's HTML
 * 502 page yields `null`, never a throw.
 */
export function parseOperatorAgentErrorCode(
  err: unknown,
): OperatorAgentErrorCode | null {
  if (!(err instanceof ApiError)) return null;
  try {
    const parsed = JSON.parse(err.body) as { error?: unknown };
    return typeof parsed.error === 'string' &&
      OPERATOR_AGENT_ERROR_CODE_SET.has(parsed.error)
      ? (parsed.error as OperatorAgentErrorCode)
      : null;
  } catch {
    return null;
  }
}

// ── W2a (#860) — per-agent Teams bot identity ──────────────────────────

/**
 * Provisioning-chain vocabulary, mirroring `TEAMS_PROVISIONING_STATES` in
 * `middleware/src/platform/agentTeamsIdentityStore.ts` (itself the CHECK
 * constraint of migration 0049, verbatim). Structural contract, same
 * arrangement as the service-name literals: the middleware owns the
 * vocabulary, this module only recognises it, neither imports the other.
 *
 * Order is significant — the panel renders the array as the progress chain,
 * so `installed` and `failed` (the two terminals) sit last on purpose.
 */
export const TEAMS_PROVISIONING_STATES = [
  'pending',
  'app_registered',
  'bot_created',
  'package_built',
  'catalog_uploaded',
  'installed',
  'failed',
] as const;

export type TeamsProvisioningState = (typeof TEAMS_PROVISIONING_STATES)[number];

/** The chain a healthy run walks, without the `failed` sink — the ordered
 *  steps a progress display shows. */
export const TEAMS_PROVISIONING_CHAIN = TEAMS_PROVISIONING_STATES.filter(
  (s): s is Exclude<TeamsProvisioningState, 'failed'> => s !== 'failed',
);

/** Polling contract: only these two states end the run. Everything else —
 *  including a non-terminal `app_registered` carrying a `last_error` — means
 *  the runner may still advance, so the panel keeps polling. */
export function isTerminalTeamsProvisioningState(
  state: TeamsProvisioningState,
): boolean {
  return state === 'installed' || state === 'failed';
}

/**
 * Machine codes of the classifier the middleware runs over `last_error`
 * server-side, next to the job runner that WRITES those sentences
 * (`services/teamsProvisioningJob.ts`).
 *
 * Deliberately NOT parsed here: an English-sentence parser in web-ui would
 * silently degrade in production the day someone rewords a message, whereas
 * a classifier colocated with the producer breaks a unit test instead. This
 * module only narrows the already-structured projection.
 */
export const TEAMS_IDENTITY_LAST_ERROR_CODES = [
  'consent_missing',
  'arm_not_configured',
  'throttled',
  // #910 — the one code that is a WARNING, not a failure: the identity is
  // provisioned and installed, only the automatic `teams_bots` write did not
  // land, so the operator falls back to the copy-paste block.
  'config_sync_failed',
  // #921 — the Azure bot handle is taken in the GLOBAL Bot Service namespace.
  // Terminal and deterministic: re-running changes nothing, the operator has
  // to rename the bot slug.
  'bot_handle_unavailable',
  // #924 — the four delegated codes. FOUR, not one, because each sends the
  // operator somewhere else: start a tenant sign-in, send an admin to a
  // consent URL, sign in again, or go look at the publisher app's device-code
  // configuration. Three of them are PARKED runs, not failures — the chain
  // keeps everything it built and resumes once the human step is done.
  'delegated_sign_in_required',
  'delegated_consent_required',
  'delegated_token_expired',
  'device_code_flow_failed',
  // Graph refused the install because this agent's app package declares
  // resource-specific permissions the installing identity may not consent to
  // — a tenant role grant, NOT a wrong target id, and worth its own code
  // because reporting it as a generic bad request sends the operator back to
  // re-check an id that was correct all along
  'rsc_permissions_mismatch',
  // #2043 — the target's own resource-specific consent check refused the
  // install: permanent, and neither a wrong id nor a missing role
  'rsc_consent_refused',
  // #2043 — the Bot Connector answers 401 to the bot's own credentials: the
  // run was green in Azure and the bot is invalid in Teams
  'bot_rejected',
  // #2043 — the connector refused to create a bot under an app id whose bot
  // was deleted before: it would be rejected by the Bot Connector for good
  'bot_app_id_retired',
  // #2043 D22 — Graph kept refusing a follow-up call on the new app
  // registration; replication or ownership, not missing consent
  'app_registration_not_ready',
  'unknown',
] as const;

export type TeamsIdentityLastErrorCode =
  (typeof TEAMS_IDENTITY_LAST_ERROR_CODES)[number];

const TEAMS_IDENTITY_LAST_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  TEAMS_IDENTITY_LAST_ERROR_CODES,
);

/** Server-side projection of `last_error` (route field `last_error_detail`).
 *  `raw` is the original sentence — renderable only as a secondary technical
 *  detail, never as the primary user-facing copy. */
export interface TeamsIdentityLastErrorDetailDto {
  code: TeamsIdentityLastErrorCode;
  /** Graph scopes still awaiting admin consent (`consent_missing`). */
  scopes?: string[];
  /** Connector setup fields still missing (`arm_not_configured`). */
  fields?: string[];
  /** Backoff hint (`throttled`). */
  retryAfterSeconds?: number;
  /** Why the automatic `teams_bots` write did not land
   *  (`config_sync_failed`) — a technical sentence, rendered as the ICU
   *  argument of a localized line, never as the copy itself. */
  reason?: string;
  /** #924 — where an admin grants the delegated scopes
   *  (`delegated_consent_required`). Validated as absolute https server-side
   *  before the sentence is written AND again when it is decoded, so the panel
   *  may render it as a link without a third check. */
  adminConsentUrl?: string;
  /** #2043 — what Microsoft named in an `rsc_consent_refused` answer: Graph's
   *  error code, its inner code and the Teams backend request it relayed.
   *  Identifiers, shown as ICU arguments. */
  graphCode?: string;
  innerCode?: string;
  backendRequest?: string;
  raw: string;
}

/** Short identifier-shaped strings only: these are rendered next to copy. */
function identifierFields<K extends string>(
  obj: Record<string, unknown> | null,
  keys: readonly K[],
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === 'string' && /^[\w.-]{1,120}$/.test(value)) out[key] = value;
  }
  return out;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every((v) => typeof v === 'string')
    ? (value as string[])
    : undefined;
}

/**
 * Narrow `identity.last_error_detail` at the boundary.
 *
 * Total by construction, and deliberately tolerant: a middleware that does
 * not emit the field yet (or emits a shape this client does not know) still
 * yields a usable `{ code: 'unknown', raw }` so the panel renders the
 * localized fallback with the sentence as a technical argument instead of
 * losing the error entirely. Returns `null` only when there is no error.
 */
export function parseTeamsIdentityLastErrorDetail(
  detail: unknown,
  lastError: string | null,
): TeamsIdentityLastErrorDetailDto | null {
  if (lastError === null || lastError === '') return null;
  const obj =
    detail !== null && typeof detail === 'object'
      ? (detail as Record<string, unknown>)
      : null;
  const rawCode = obj?.['code'];
  const code: TeamsIdentityLastErrorCode =
    typeof rawCode === 'string' && TEAMS_IDENTITY_LAST_ERROR_CODE_SET.has(rawCode)
      ? (rawCode as TeamsIdentityLastErrorCode)
      : 'unknown';
  const scopes = stringList(obj?.['scopes']);
  const fields = stringList(obj?.['fields']);
  const retry = obj?.['retryAfterSeconds'];
  const reason = obj?.['reason'];
  const consentUrl = obj?.['adminConsentUrl'];
  const rawText = obj?.['raw'];
  return {
    code,
    ...(scopes ? { scopes } : {}),
    ...(fields ? { fields } : {}),
    // Re-checked here too: this value becomes an `href`, and a row written by
    // an older build is untrusted text as far as this boundary is concerned.
    ...(typeof consentUrl === 'string' && consentUrl.startsWith('https://')
      ? { adminConsentUrl: consentUrl }
      : {}),
    ...(typeof retry === 'number' && Number.isFinite(retry)
      ? { retryAfterSeconds: retry }
      : {}),
    ...(typeof reason === 'string' && reason !== '' ? { reason } : {}),
    ...identifierFields(obj, ['graphCode', 'innerCode', 'backendRequest']),
    raw: typeof rawText === 'string' && rawText !== '' ? rawText : lastError,
  };
}

/** `agent_teams_identities` row as the status route projects it. Snake_case
 *  mirrors the REST payload verbatim, like the other operator DTOs here. */
export interface TeamsIdentityDto {
  bot_slug: string;
  display_name: string;
  app_id: string | null;
  tenant_id: string | null;
  teams_app_id: string | null;
  teams_app_external_id: string | null;
  /** Recorded install target. The POST REQUIRES `team_id` and has no
   *  fall-back-to-stored path on the server, so a re-run has to resend this
   *  value. `null` on a row created before a target was known. */
  team_id: string | null;
  last_error: string | null;
  /** Server-side classification of `last_error` — additive, so a middleware
   *  predating the projection simply omits it. */
  last_error_detail?: unknown;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * The channel-teams `teams_bots[]` projection — shaped EXACTLY like a
 * `parseTeamsBotsConfig` entry (hence camelCase inside an otherwise
 * snake_case payload), so an operator can paste it into the channel-teams
 * config verbatim. Null until the Entra app exists. Never carries secret
 * material: `appPasswordSecretRef` is an opaque credential-store ref.
 */
export interface TeamsBotConfigEntryDto {
  botSlug: string;
  displayName: string;
  appId: string;
  appType: 'SingleTenant';
  tenantId: string;
  appPasswordSecretRef: string;
}

/**
 * #910 — is the `teams_bot` entry above ACTUALLY in the channel-teams plugin
 * config right now?
 *
 * Derived server-side from the live plugin config on every read, never from a
 * stored "we synced it" flag: an operator can edit or delete the entry at any
 * time, and a remembered intention would then tell this screen a comfortable
 * lie. Additive — a middleware predating #910 omits the field, which the
 * boundary narrows to `unknown`.
 */
export const TEAMS_BOTS_SYNC_STATES = [
  'synced',
  'out_of_sync',
  'missing',
  'plugin_not_installed',
  'unreadable',
  'not_applicable',
  'unknown',
] as const;

export type TeamsBotsSyncState = (typeof TEAMS_BOTS_SYNC_STATES)[number];

const TEAMS_BOTS_SYNC_STATE_SET: ReadonlySet<string> = new Set(
  TEAMS_BOTS_SYNC_STATES,
);

export interface TeamsBotsSyncDto {
  state: TeamsBotsSyncState;
  /** The plugin the entry belongs to — named in the operator copy. */
  plugin_id: string;
  /** The setup field the entry lives in (`teams_bots`). */
  config_key: string;
}

/** Narrow `teams_bots_sync` at the boundary. Total: an absent or unknown
 *  shape yields `unknown`, which renders as "we cannot tell — the manual
 *  block below still works". */
export function parseTeamsBotsSync(value: unknown): TeamsBotsSyncDto {
  const obj =
    value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null;
  const rawState = obj?.['state'];
  const pluginId = obj?.['plugin_id'];
  const configKey = obj?.['config_key'];
  return {
    state:
      typeof rawState === 'string' && TEAMS_BOTS_SYNC_STATE_SET.has(rawState)
        ? (rawState as TeamsBotsSyncState)
        : 'unknown',
    plugin_id:
      typeof pluginId === 'string' && pluginId !== ''
        ? pluginId
        : '@omadia/channel-teams',
    config_key:
      typeof configKey === 'string' && configKey !== '' ? configKey : 'teams_bots',
  };
}

export interface TeamsIdentityStatusDto {
  ok: boolean;
  agent: string;
  state: TeamsProvisioningState;
  /** Honest signal: true only while the runner actually holds a run for this
   *  agent — a rejected enqueue leaves it false even in a `pending` row. */
  running: boolean;
  provisioner_installed: boolean;
  identity: TeamsIdentityDto;
  teams_bot: TeamsBotConfigEntryDto | null;
  /** Additive (#910) — see {@link parseTeamsBotsSync}. */
  teams_bots_sync?: unknown;
  /** Additive (#915) — the current run's step timeline, newest first. Narrowed
   *  by `parseTeamsProvisioningEvents` in `_lib/teamsIdentity.ts`; a middleware
   *  predating migration 0053 simply omits the field. */
  provisioning_events?: unknown;
}

/** `GET /v1/operator/agents/:slug/teams-identity`. Rejects with a 404
 *  `teams_identity_not_found` when the agent has no identity row yet — that
 *  is the "show the create form" signal, not an error. */
export async function getAgentTeamsIdentity(
  slug: string,
): Promise<TeamsIdentityStatusDto> {
  return callJson<TeamsIdentityStatusDto>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/teams-identity`,
  );
}

/**
 * `team_id` is REQUIRED — `TeamsIdentityProvisionSchema` in
 * `middleware/src/routes/operatorAgents.ts` declares it `z.string().min(1)`
 * and the runner port types `enqueue({ agentId, teamId: string })`. Only
 * `bot_slug` and `display_name` are optional; the server derives them from
 * the agent when omitted, and ignores them on a re-run.
 */
export interface ProvisionTeamsIdentityInput {
  bot_slug?: string;
  display_name?: string;
  team_id: string;
  /**
   * WHAT THE DIRECTORY SAID this target is, when it came from the picker
   * rather than the text field.
   *
   * Optional and absent for anything typed. Sent so the middleware does not
   * re-derive the kind from the id's suffix: a shape the pattern table has
   * never seen — a legacy `19:…@thread.skype` group chat today, whatever
   * Microsoft mints next — is refused there even though Graph had just listed
   * it as an install target.
   */
  target_kind?: TeamsTargetKind;
}

export interface ProvisionTeamsIdentityResponse {
  ok: boolean;
  agent: string;
  bot_slug: string;
  state: TeamsProvisioningState;
  running: boolean;
}

/** `POST /v1/operator/agents/:slug/teams-identity` — 202, create-if-absent
 *  plus a fire-and-forget provisioning run. Idempotent on the server. */
export async function provisionAgentTeamsIdentity(
  slug: string,
  input: ProvisionTeamsIdentityInput,
): Promise<ProvisionTeamsIdentityResponse> {
  return callJson<ProvisionTeamsIdentityResponse>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/teams-identity`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

/**
 * Machine codes the teams-identity routes emit as `{ error: '<code>' }`.
 *
 * A separate union from {@link OPERATOR_AGENT_ERROR_CODES} on purpose: these
 * routes add codes (`bot_slug_taken`, the two 503 capability gates, the
 * `teams_identity_not_found` control signal) that the plugin/grant catalogues
 * have no copy for, and widening the shared union would force every existing
 * `detailErrors.*` / `grants.errors.*` catalogue to grow keys it never
 * renders.
 */
/**
 * Browser URL of the Teams app-package download (#924).
 *
 * A plain link rather than a fetch-and-blob: the response carries
 * `Content-Disposition: attachment`, so the browser saves it with the right
 * filename and streams it without the page holding the bytes in memory.
 * Same-origin `/bot-api` proxy, so the session cookie rides along.
 *
 * A FALLBACK, NOT THE PATH. Provisioning uploads the package itself through
 * the tenant sign-in; this exists for tenants that forbid programmatic
 * catalog writes and for admins who want to read the manifest first.
 */
export function agentTeamsPackageUrl(slug: string): string {
  return `/bot-api/v1/operator/agents/${encodeURIComponent(slug)}/teams-identity/package`;
}

export const TEAMS_IDENTITY_ERROR_CODES = [
  'bot_slug_taken',
  'invalid_body',
  'invalid_slug',
  'multi_orchestrator_unavailable',
  'not_found',
  'teams_identity_not_found',
  'teams_identity_unavailable',
  'teams_provisioner_unavailable',
] as const;

export type TeamsIdentityErrorCode =
  (typeof TEAMS_IDENTITY_ERROR_CODES)[number];

const TEAMS_IDENTITY_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  TEAMS_IDENTITY_ERROR_CODES,
);

/** Same contract as {@link parseOperatorAgentErrorCode}: total, `null` for
 *  anything this client does not recognise. */
export function parseTeamsIdentityErrorCode(
  err: unknown,
): TeamsIdentityErrorCode | null {
  if (!(err instanceof ApiError)) return null;
  try {
    const parsed = JSON.parse(err.body) as { error?: unknown };
    return typeof parsed.error === 'string' &&
      TEAMS_IDENTITY_ERROR_CODE_SET.has(parsed.error)
      ? (parsed.error as TeamsIdentityErrorCode)
      : null;
  } catch {
    return null;
  }
}

export async function replaceAgentPlugins(
  slug: string,
  plugins: Array<{ id: string; config?: Record<string, unknown>; enabled?: boolean }>,
): Promise<void> {
  await callJson(`/v1/operator/agents/${encodeURIComponent(slug)}/plugins`, {
    method: 'PUT',
    body: JSON.stringify({ plugins }),
  });
}

export async function replaceAgentBindings(
  slug: string,
  bindings: Array<{ channel_type: string; channel_key: string }>,
): Promise<void> {
  await callJson(`/v1/operator/agents/${encodeURIComponent(slug)}/bindings`, {
    method: 'PUT',
    body: JSON.stringify({ bindings }),
  });
}

/**
 * #2055 — set the instance entry of the default-agent table: the agent that
 * answers an unaddressed message when no user or channel entry applies.
 * `null` = off. The server answers 409 when the agent is not available to
 * everyone in every channel, or is a facilitator.
 */
export async function setInstanceDefaultAgent(slug: string | null): Promise<void> {
  await callJson('/v1/operator/default-agents', {
    method: 'PUT',
    body: JSON.stringify({ principal: null, channel_type: null, agent_slug: slug }),
  });
}

/**
 * #2055 — one entry of the default-agent table: who (`principal`, null =
 * everyone) in which channel (`channel_type`, null = every channel) reaches
 * which agent when they address none; `off` = no agent, a system notice.
 * The entry with both null is the instance entry: it is set, never removed.
 */
export interface DefaultAgentEntryDto {
  id: string;
  principal: string | null;
  channel_type: string | null;
  off: boolean;
  agent_slug: string | null;
  agent_name: string | null;
  /** `deleted` / `disabled` / `enabled` …: messages there get a notice naming the agent. */
  agent_status: string | null;
  updated_by: string | null;
  updated_at: string;
}

export async function listDefaultAgentEntries(): Promise<DefaultAgentEntryDto[]> {
  const res = await callJson<{ entries: DefaultAgentEntryDto[] }>('/v1/operator/default-agents');
  return res.entries;
}

/** Set (or change) one entry; `agentSlug: null` = `off`. 409 carries why the agent may not be named there. */
export async function putDefaultAgentEntry(input: {
  principal: string | null;
  channelType: string | null;
  agentSlug: string | null;
}): Promise<void> {
  await callJson('/v1/operator/default-agents', {
    method: 'PUT',
    body: JSON.stringify({
      principal: input.principal,
      channel_type: input.channelType,
      agent_slug: input.agentSlug,
    }),
  });
}

export async function deleteDefaultAgentEntry(id: string): Promise<void> {
  await callJson(`/v1/operator/default-agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function drainAgentSessions(slug: string): Promise<{ affected: number }> {
  return callJson(`/v1/operator/agents/${encodeURIComponent(slug)}/drain`, {
    method: 'POST',
  });
}

export async function killAgentSessions(slug: string): Promise<{ affected: number }> {
  return callJson(`/v1/operator/agents/${encodeURIComponent(slug)}/kill`, {
    method: 'POST',
  });
}

export async function triggerAgentReload(): Promise<{
  actions: number;
  platform_changed: boolean;
}> {
  return callJson('/v1/operator/agents/reload', { method: 'POST' });
}

// ── Phase A — chat-picker surface ──────────────────────────────────────

export interface EnabledAgentDto {
  slug: string;
  name: string;
  description: string | null;
  /** Reserved, not enforced (#978): persisted and reported, read by no
   *  runtime path — `strict` behaves like `default`. */
  privacy_profile: PrivacyProfile;
  /** The archetype the middleware already reports on this route; absent on
   *  one that predates archetypes (read it through `archetypeOfAgent`). */
  archetype?: AgentArchetype;
  /** #2057 — `agent_identities.display_name`. Optional: the route does not
   *  deliver the identity yet, so the name falls back to `name`, then slug. */
  display_name?: string | null;
  /** #2057 — `agent_identities.short_description`; falls back to `description`. */
  short_description?: string | null;
  /** #2057 — the avatar reference as the identity route reports it. */
  avatar?: { etag: string; url: string } | null;
  /** #2057 — systems the agent can read or write through its grants, as
   *  display names. Absent until the middleware reports it; never guessed. */
  reach?: string[] | null;
}

export interface EnabledAgentsListDto {
  agents: EnabledAgentDto[];
  /** #2055 — slug of the instance default agent (`null` = off). */
  default_slug: string | null;
}

/**
 * Minimal-metadata list of enabled Agents for the chat header picker
 * (Phase A). Does NOT reveal plugin/binding internals. Backed by
 * `GET /api/v1/operator/agents/enabled` in the middleware.
 */
export async function listEnabledAgents(): Promise<EnabledAgentsListDto> {
  return callJson<EnabledAgentsListDto>('/v1/operator/agents/enabled');
}

/**
 * #2057 — one agent in the directory a person sees in a channel
 * (`GET /api/v1/agents/directory?channel=`, kernel contract of stream S1).
 */
export interface AgentDirectoryEntryDto {
  slug: string;
  display_name: string;
  short_description: string | null;
  avatar_url: string | null;
  /** `standard`, or the id of an archetype an archetype plugin delivers; `null` = standard. */
  archetype: string | null;
}

/** The agent that answers what nobody addressed, or why there is none. */
export type AgentDirectoryDefaultDto =
  | { slug: string }
  | { slug: null; notice: string };

export interface AgentDirectoryDto {
  channel: string;
  agents: AgentDirectoryEntryDto[];
  default_agent: AgentDirectoryDefaultDto;
}

/**
 * The agents available to the signed-in person in `channel`, already filtered
 * by availability on the server (spec 2042 §5.3, criterion 40).
 */
export async function getAgentDirectory(channel: string): Promise<AgentDirectoryDto> {
  return callJson<AgentDirectoryDto>(
    `/v1/agents/directory?channel=${encodeURIComponent(channel)}`,
  );
}

// ── Phase B — operator dashboard support surfaces ───────────────────────

export type PluginKind =
  | 'agent'
  | 'integration'
  | 'channel'
  | 'tool'
  | 'extension'
  | 'archetype';

export type SetupFieldType =
  | 'string'
  | 'password'
  | 'secret'
  | 'url'
  | 'oauth'
  | 'enum'
  | 'host_list'
  | 'number'
  | 'boolean';

export interface PluginSetupFieldDto {
  key: string;
  /** #602 (OM-17) — the manifest loader normalises `label` into a
   *  `{ <locale>: text }` map (`?? { en: key }`), so this is NOT a plain
   *  string on any current middleware. Rendering it directly threw React #31
   *  ("Objects are not valid as a React child") and took the whole orchestrator
   *  page down via the route error boundary. Resolve with `pickLocalized`.
   *  The bare-string arm covers payloads from a pre-#602 middleware. */
  label: LocalizedMarkdown | string;
  type: SetupFieldType;
  /** #602 (OM-17) — localized help map; same contract as `label`. */
  help?: LocalizedMarkdown | string;
  /** Typed like the manifest field: `boolean` (#1464), `number` for an
   *  `integer` field (#1524), `string[]` for a `host_list`. */
  default?: string | string[] | boolean | number;
  enum?: Array<{ value: string; label: string; label_localized?: LocalizedMarkdown }>;
}

export interface PluginCatalogEntryDto {
  id: string;
  name: string;
  kind: PluginKind;
  version: string;
  multi_instance: boolean;
  multi_instance_justification?: string;
  privacy_class: PrivacyProfile;
  memory_reads: string[];
  memory_writes: string[];
  network_outbound: string[];
  setup_fields: PluginSetupFieldDto[];
  depends_on: string[];
}

export interface PluginCatalogListDto {
  items: PluginCatalogEntryDto[];
}

/**
 * Installed-plugin metadata for the B3a multi-select / B3c config editor.
 * Backed by `GET /api/v1/operator/agents/plugin-catalog`.
 */
export async function listAgentPluginCatalog(): Promise<PluginCatalogListDto> {
  return callJson<PluginCatalogListDto>(
    '/v1/operator/agents/plugin-catalog',
  );
}

export interface ResolveChannelResponse {
  matched: {
    slug: string;
    name: string;
    /** Reserved, not enforced (#978). */
    privacy_profile: PrivacyProfile;
  } | null;
  /** `identity` — the key IS an agent's provisioned bot, which outranks
   *  every binding; `default` — the default-agent table (#2055). See the
   *  orchestrator's ChannelResolver. */
  via: 'identity' | 'explicit' | 'selection' | 'binding' | 'default' | 'none';
  /** #2055 — with no match: the `system` notice the sender would get. */
  notice?: { code: string; text: string; locale: string } | null;
}

/**
 * B3b routing tester. Asks the server which Agent (if any) would handle
 * an inbound webhook for `{channel_type, channel_key}`.
 */
export async function resolveAgentForChannel(
  channelType: string,
  channelKey: string,
): Promise<ResolveChannelResponse> {
  return callJson<ResolveChannelResponse>(
    '/v1/operator/agents/resolve-channel',
    {
      method: 'POST',
      body: JSON.stringify({
        channel_type: channelType,
        channel_key: channelKey,
      }),
    },
  );
}

/**
 * #679 / I5 — the description the middleware seeds into the fallback Agent on
 * first boot (`FALLBACK_AGENT_SEED_DESCRIPTION` in
 * `packages/harness-orchestrator/src/registry/onboarding.ts`).
 *
 * Structural contract, same arrangement as the service-name literals: the
 * middleware writes it, this module only recognises it, and neither imports the
 * other. Keep the two spellings in sync.
 */
const FALLBACK_AGENT_SEED_DESCRIPTION =
  'Auto-seeded on first boot. Receives unbound channel traffic until the operator configures explicit bindings.';

/**
 * Is this description the untouched server-written seed?
 *
 * The seed is written once, at boot, before any locale exists to write it in —
 * so it is a record of why the row exists, not UI copy, and the UI renders its
 * own localised sentence instead. Exact match on purpose: the moment an
 * operator edits the description, those are their words and they are shown
 * verbatim in whatever language they chose. A fuzzy match would silently
 * overwrite operator content that merely resembled the seed.
 */
export function isSeededAgentDescription(
  description: string | null | undefined,
): boolean {
  return description?.trim() === FALLBACK_AGENT_SEED_DESCRIPTION;
}

// ── W2a (#860) — team↔agent assignment read model ───────────────────────
//
// Backed by the wave's install routes in `routes/operatorAgents.ts`:
//
//   GET    /v1/operator/agents/:slug/teams
//   POST   /v1/operator/agents/:slug/teams
//   DELETE /v1/operator/agents/:slug/teams/:teamId
//
// The read model is DERIVED from the agent's `agent_teams_identities` row,
// not enumerated from Graph: `teamsProvisioner@1` publishes no listing and no
// uninstall method, and migration 0049 stores ONE `team_id` per agent. The
// route therefore ships those limits as data (`capabilities`) so this client
// — and the panel above it — can disable a control instead of discovering the
// gap through a failed request.

/** One team the agent's Teams app is known to be installed in. */
export interface InstalledTeamDto {
  team_id: string;
  /**
   * Graph display name of the team, as the middleware last resolved it —
   * `null` when it never could (connector absent, below 0.5.0, or the team is
   * not visible). Optional on the wire: a middleware predating migration 0051
   * omits the field entirely, which {@link parseInstalledTeamName} narrows to
   * `null` so the UI shows the id alone instead of an `undefined` label.
   */
  team_display_name?: string | null;
  /** When that name was last refreshed. Presentational only. */
  display_name_synced_at?: string | null;
  /** Catalog id of the installed app; null until the upload step ran. */
  teams_app_id: string | null;
  /** ISO timestamp of the row write that recorded the install — NOT a Graph
   *  timestamp, the connector reports none. */
  installed_at: string | null;
  /**
   * Where the entry comes from — a persisted binding
   * (`agent_teams_installs`, migration 0051) or the legacy single-column
   * derivation. Neither is a live Graph enumeration.
   */
  evidence: 'identity_row' | 'install_row';
  /**
   * WHICH KIND of target `team_id` addresses (middleware migration 0054).
   * Optional on the wire: a middleware predating it omits the field, and
   * every row it could have written was a team — so
   * {@link parseInstalledTargetKind} defaults to `'team'` rather than
   * rendering an empty label.
   */
  target_kind?: TeamsTargetKind | null;
}

/** The entry's target kind, narrowed at the boundary — see the field's note
 *  for why an absent value is `'team'` and not an error. */
export function parseInstalledTargetKind(team: InstalledTeamDto): TeamsTargetKind {
  const kind = team.target_kind;
  return kind === 'group-chat' || kind === 'one-on-one-chat' || kind === 'team'
    ? kind
    : 'team';
}

/** The team's name, or `null` — the one place the wire's optional/nullable
 *  field is narrowed, so no component renders `undefined` into a label. */
export function parseInstalledTeamName(team: InstalledTeamDto): string | null {
  const name = team.team_display_name;
  return typeof name === 'string' && name.trim() !== '' ? name : null;
}

export type TeamsConsentStatus = 'granted' | 'missing' | 'unknown';

/** Admin-consent verdict for the tenant the identity is provisioned in.
 *  There is no live probe, so `source` names what the verdict rests on. */
export interface TeamsConsentDto {
  status: TeamsConsentStatus;
  missing_scopes: string[];
  source: 'last_error' | 'provisioning_state' | 'none';
}

/** Capability keys the route reports, in render order. `unsupported_reason`
 *  is keyed by these; the UI renders its OWN localized reason per key and may
 *  show the server sentence only as a secondary technical detail. */
export const TEAMS_ASSIGNMENT_CAPABILITY_KEYS = [
  'install',
  'uninstall',
  'enumerate',
  'multi_team',
  'chat_install',
  'chat_uninstall',
] as const;

export type TeamsAssignmentCapabilityKey =
  (typeof TEAMS_ASSIGNMENT_CAPABILITY_KEYS)[number];

export type TeamsAssignmentCapabilitiesDto = Record<
  TeamsAssignmentCapabilityKey,
  boolean
> & {
  unsupported_reason: Record<string, string>;
};

export interface AgentTeamsDto {
  ok: boolean;
  agent: string;
  /** Provisioning-chain state. Its vocabulary belongs to the Teams identity
   *  panel, which owns the localized state copy — this client carries it as
   *  an opaque marker so the assignment panel never renders a raw state. */
  state: string;
  running: boolean;
  provisioner_installed: boolean;
  teams: InstalledTeamDto[];
  /** The recorded install TARGET while the chain has not reached
   *  `installed` — a run in flight (or a stalled one), never an install. */
  pending_team_id: string | null;
  /** Kind of `pending_team_id`, so the in-flight hint can name what is being
   *  installed into instead of calling every target a team. Optional for the
   *  same version-skew reason as `InstalledTeamDto.target_kind`. */
  pending_target_kind?: TeamsTargetKind | null;
  consent: TeamsConsentDto;
  last_error: string | null;
  capabilities: TeamsAssignmentCapabilitiesDto;
}

/** Fail-closed capability default: a middleware that does not report
 *  capabilities gets every control disabled, never an enabled one that then
 *  fails against a route it cannot serve. */
const TEAMS_ASSIGNMENT_CAPABILITIES_CLOSED: TeamsAssignmentCapabilitiesDto = {
  install: false,
  uninstall: false,
  enumerate: false,
  multi_team: false,
  chat_install: false,
  chat_uninstall: false,
  unsupported_reason: {},
};

function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/**
 * Narrow the capability block at the boundary.
 *
 * Total by construction and fail-closed: an absent block, a partial one, or a
 * non-boolean flag all collapse to "not supported". The UI then renders a
 * disabled control with its reason instead of a button that 501s.
 */
export function parseTeamsAssignmentCapabilities(
  value: unknown,
): TeamsAssignmentCapabilitiesDto {
  if (value === null || typeof value !== 'object') {
    return TEAMS_ASSIGNMENT_CAPABILITIES_CLOSED;
  }
  const obj = value as Record<string, unknown>;
  const flags = Object.fromEntries(
    TEAMS_ASSIGNMENT_CAPABILITY_KEYS.map((key) => [key, obj[key] === true]),
  ) as Record<TeamsAssignmentCapabilityKey, boolean>;
  return { ...flags, unsupported_reason: stringRecord(obj['unsupported_reason']) };
}

/**
 * `GET /v1/operator/agents/:slug/teams` — the teams the agent's app is
 * installed in, plus consent status and what the platform can actually do.
 *
 * Rejects with 404 `teams_identity_not_found` when the agent has no identity
 * row yet; that is the "there is nothing to assign yet" signal, and the panel
 * treats it as an empty state rather than an error.
 */
/**
 * Why a target listing is not available. Mirrors
 * `TeamsTargetListingUnavailable` in
 * `middleware/src/services/teamsTargetDirectoryService.ts` — a closed set of
 * machine codes, each with its own sentence in `messages/*.json`.
 */
export const TEAMS_TARGET_LISTING_UNAVAILABLE = [
  /** #2043 — the server is still enumerating a large tenant; ask again. */
  'loading',
  /** #2043 — this half was not asked for: the tenant's chats are listed only
   *  for a search, never just to open the picker. */
  'not_requested',
  'connector_unavailable',
  'connector_unsupported',
  /** NOBODY is signed in — and since #949 nothing else. */
  'sign_in_required',
  /**
   * Somebody IS signed in, their access token is spent, and renewing it
   * failed. Kept apart from `sign_in_required` because the two send an
   * operator to the same button with completely different expectations, and
   * folding them together is what put "sign in once" in front of an admin
   * whose account was on screen.
   */
  'sign_in_expired',
  'scope_missing',
  'consent_required',
  'lookup_failed',
] as const;

export type TeamsTargetListingUnavailable =
  (typeof TEAMS_TARGET_LISTING_UNAVAILABLE)[number];

/**
 * Is this a reason this build has a sentence for?
 *
 * A RUNTIME check and not merely a cast, because the middleware ships
 * independently of this bundle: a server that learns a new reason code before
 * the UI does would otherwise hand it straight to `t()` and render a missing
 * translation key at the operator. Degrading to `lookup_failed` is honest —
 * we could not look, and we cannot say why — and it is exactly how
 * `sign_in_expired` itself would have surfaced on an older build.
 */
export function isTeamsTargetListingUnavailable(
  value: unknown,
): value is TeamsTargetListingUnavailable {
  return (
    typeof value === 'string' &&
    (TEAMS_TARGET_LISTING_UNAVAILABLE as readonly string[]).includes(value)
  );
}

/**
 * A listing that can say "I don't know".
 *
 * THE WHOLE POINT OF THE UNION. `available: true, items: []` means the tenant
 * genuinely has none; `available: false` means we could not look. Rendering
 * an empty dropdown for the second case tells the operator something false
 * about their tenant and sends them looking in the wrong place.
 */
export type TeamsTargetListingDto<T> =
  | {
      available: true;
      items: readonly T[];
      /** #2043 — how many the tenant has; set when the server sent fewer. */
      total?: number;
      truncated?: boolean;
      /** The connector's own list stopped early (M365 connector >= 0.9.1
       *  reports it): the list is incomplete and `total` a lower bound. */
      sourceTruncated?: boolean;
      /** Chats: untitled chats that have no member names to label them. */
      withoutMemberNames?: number;
      /** Chats: whose members the filter can match. Since connector 0.9.1 a
       *  chat WITH a name carries no members, so only untitled ones do. */
      memberSearch?: 'all' | 'untitled_only' | 'none';
    }
  | { available: false; reason: TeamsTargetListingUnavailable };

export interface TeamsTeamOptionDto {
  id: string;
  displayName: string;
}

export interface TeamsChatOptionDto {
  id: string;
  topic: string | null;
  chatType: 'group' | 'oneOnOne' | 'meeting';
  memberNames?: readonly string[];
}

/** A chat one of the instance's bots already holds a reference in (#2043):
 *  the picker's default list, known without asking Microsoft. */
export interface TeamsRecentTargetDto {
  id: string;
  kind: 'group-chat' | 'one-on-one-chat';
  label: string | null;
  /** This agent's own bot is already in that chat. */
  knownToThisBot: boolean;
}

export interface AgentTeamsTargetsDto {
  ok: boolean;
  agent: string;
  provisioner_installed: boolean;
  teams: TeamsTargetListingDto<TeamsTeamOptionDto>;
  chats: TeamsTargetListingDto<TeamsChatOptionDto>;
  /** Absent on an older middleware, or when the list could not be read. */
  recent?: readonly TeamsRecentTargetDto[];
}

function parseRecentTargets(value: unknown): readonly TeamsRecentTargetDto[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record['available'] !== true || !Array.isArray(record['items'])) return undefined;
  const items: TeamsRecentTargetDto[] = [];
  for (const raw of record['items']) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const id = r['id'];
    const kind = r['kind'];
    if (typeof id !== 'string' || id === '') continue;
    if (kind !== 'group-chat' && kind !== 'one-on-one-chat') continue;
    items.push({
      id,
      kind,
      label: typeof r['label'] === 'string' && r['label'] !== '' ? r['label'] : null,
      knownToThisBot: r['knownToThisBot'] === true,
    });
  }
  return items;
}

/** What to ask the directory for. Without `q` the tenant's chats are not
 *  enumerated; the answer carries teams and `recent` only. */
export interface TeamsTargetsQuery {
  readonly q?: string;
}

/**
 * Normalise one half of the directory response.
 *
 * DEFENSIVE ON PURPOSE, and it degrades toward `available: false` rather than
 * toward an empty list: an unparsable payload is precisely the case where we
 * do NOT know what the tenant holds, and the union exists so that state has
 * somewhere honest to go.
 */
function parseTargetListing<T>(
  value: unknown,
  parseItem: (raw: unknown) => T | null,
): TeamsTargetListingDto<T> {
  if (typeof value !== 'object' || value === null) {
    return { available: false, reason: 'lookup_failed' };
  }
  const record = value as Record<string, unknown>;
  if (record['available'] !== true) {
    const reason = record['reason'];
    return {
      available: false,
      // Validated, not cast — see `isTeamsTargetListingUnavailable`. A code
      // this build has no sentence for must not reach `t()`.
      reason: isTeamsTargetListingUnavailable(reason) ? reason : 'lookup_failed',
    };
  }
  const raw = record['items'];
  if (!Array.isArray(raw)) return { available: false, reason: 'lookup_failed' };
  const items: T[] = [];
  for (const entry of raw) {
    const parsed = parseItem(entry);
    if (parsed !== null) items.push(parsed);
  }
  const total = record['total'];
  const truncated = record['truncated'] === true;
  const sourceTruncated = record['sourceTruncated'] === true;
  const unnamed = record['withoutMemberNames'];
  const memberSearch = record['memberSearch'];
  return {
    available: true,
    items,
    ...(truncated && typeof total === 'number' && Number.isFinite(total)
      ? { total, truncated: true }
      : {}),
    ...(sourceTruncated ? { sourceTruncated: true } : {}),
    ...(typeof unnamed === 'number' && Number.isFinite(unnamed) && unnamed > 0
      ? { withoutMemberNames: unnamed }
      : {}),
    ...(memberSearch === 'all' || memberSearch === 'untitled_only' || memberSearch === 'none'
      ? { memberSearch }
      : {}),
  };
}

function parseTeamOption(raw: unknown): TeamsTeamOptionDto | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = r['id'];
  if (typeof id !== 'string' || id === '') return null;
  const displayName = r['displayName'];
  return {
    id,
    // An id with no name still beats the free-text field this replaces, so a
    // nameless row is kept and labelled by its id rather than dropped.
    displayName: typeof displayName === 'string' && displayName !== '' ? displayName : id,
  };
}

const CHAT_TYPES: readonly string[] = ['group', 'oneOnOne', 'meeting'];

function parseChatOption(raw: unknown): TeamsChatOptionDto | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = r['id'];
  if (typeof id !== 'string' || id === '') return null;
  const chatType = r['chatType'];
  const topic = r['topic'];
  const memberNames = r['memberNames'];
  return {
    id,
    topic: typeof topic === 'string' && topic !== '' ? topic : null,
    chatType: CHAT_TYPES.includes(chatType as string)
      ? (chatType as TeamsChatOptionDto['chatType'])
      : 'group',
    ...(Array.isArray(memberNames)
      ? { memberNames: memberNames.filter((n): n is string => typeof n === 'string') }
      : {}),
  };
}

/**
 * `GET /v1/operator/agents/:slug/teams/targets` — what the operator can pick
 * instead of type.
 */
export async function getAgentTeamsTargets(
  slug: string,
  query: TeamsTargetsQuery = {},
): Promise<AgentTeamsTargetsDto> {
  const q = query.q?.trim() ?? '';
  const dto = await callJson<AgentTeamsTargetsDto & { recent?: unknown }>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/teams/targets${
      q !== '' ? `?q=${encodeURIComponent(q)}` : ''
    }`,
  );
  const recent = parseRecentTargets(dto.recent);
  return {
    ok: dto.ok,
    agent: dto.agent,
    provisioner_installed: dto.provisioner_installed,
    teams: parseTargetListing(dto.teams, parseTeamOption),
    chats: parseTargetListing(dto.chats, parseChatOption),
    ...(recent !== undefined ? { recent } : {}),
  };
}

const TARGETS_UNREADABLE: Pick<AgentTeamsTargetsDto, 'teams' | 'chats'> = {
  teams: { available: false, reason: 'lookup_failed' },
  chats: { available: false, reason: 'lookup_failed' },
};

export interface LoadTeamsTargetsOptions {
  /** Called with every answer, including the intermediate `loading` ones. */
  readonly onUpdate: (dto: AgentTeamsTargetsDto) => void;
  readonly isCancelled: () => boolean;
  readonly delayMs?: number;
  readonly maxPolls?: number;
  /** A chat search: the server lists the tenant's chats only for this. */
  readonly query?: TeamsTargetsQuery;
  /** Injectable for tests. */
  readonly fetchTargets?: (slug: string, query?: TeamsTargetsQuery) => Promise<AgentTeamsTargetsDto>;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Load the team/chat directory until it is there (#2043).
 *
 * A large tenant takes longer to enumerate than one request should wait, so
 * the server answers `reason: 'loading'` and keeps going. This asks again
 * until both halves have settled, and ALWAYS ends in a state the picker can
 * show: a request that fails, or a server that never finishes, becomes
 * `lookup_failed` ("could not be loaded, type the id below") instead of the
 * endless "loading …" the panel used to sit in.
 */
export async function loadAgentTeamsTargets(
  slug: string,
  opts: LoadTeamsTargetsOptions,
): Promise<void> {
  const fetchTargets = opts.fetchTargets ?? getAgentTeamsTargets;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxPolls = opts.maxPolls ?? 40;
  const isLoading = (listing: TeamsTargetListingDto<unknown>): boolean =>
    !listing.available && listing.reason === 'loading';
  let last: AgentTeamsTargetsDto = {
    ok: false,
    agent: slug,
    provisioner_installed: false,
    ...TARGETS_UNREADABLE,
  };
  for (let poll = 0; poll < maxPolls; poll += 1) {
    try {
      last = opts.query !== undefined ? await fetchTargets(slug, opts.query) : await fetchTargets(slug);
    } catch {
      if (!opts.isCancelled()) opts.onUpdate({ ...last, ...TARGETS_UNREADABLE });
      return;
    }
    if (opts.isCancelled()) return;
    opts.onUpdate(last);
    if (!isLoading(last.teams) && !isLoading(last.chats)) return;
    await sleep(opts.delayMs ?? 3000);
    if (opts.isCancelled()) return;
  }
  opts.onUpdate({
    ...last,
    teams: isLoading(last.teams) ? TARGETS_UNREADABLE.teams : last.teams,
    chats: isLoading(last.chats) ? TARGETS_UNREADABLE.chats : last.chats,
  });
}

/**
 * HOW FAR BACK a teardown winds the agent — mirrors `TeamsResetScope`.
 *
 * `'run'` empties Azure and returns the row to `pending`, keeping the bot
 * slug and display name so a retry is one button. `'identity'` does the same
 * Azure teardown and then removes the row, so the agent has no Teams identity
 * at all and the operator picks a new slug and name from an empty form —
 * `bot_slug` is `UNIQUE`, so nothing less frees the name.
 */
export type TeamsResetScope = 'run' | 'identity';

/** One step of a teardown — mirrors `TeamsResetStepReport`. */
export interface TeamsResetStepDto {
  step:
    | 'catalog_removed'
    | 'bot_deleted'
    | 'app_deleted'
    /** The channel-teams `teams_bots` entry the chain wrote automatically
     *  (#910) — removed so a "full reset" does not leave the plugin
     *  configured with a bot whose registration has just been purged. */
    | 'config_unsynced'
    /** The `'run'` scope's last step: the row is back at `pending`. */
    | 'identity_reset'
    /** The `'identity'` scope's last step: the row is gone. */
    | 'identity_deleted';
  outcome: 'removed' | 'already-absent' | 'skipped' | 'blocked' | 'failed';
  detail?: string;
}

export interface ResetAgentTeamsIdentityResponse {
  ok: boolean;
  agent: string;
  status: 'reset' | 'incomplete';
  /** Echoed by the server so the report cannot be read against the wrong
   *  copy if a poll and a reset ever cross. */
  scope?: TeamsResetScope;
  previous_state?: string;
  steps: readonly TeamsResetStepDto[];
  stoppedAt?: TeamsResetStepDto['step'];
  detail?: string;
}

/**
 * `POST /v1/operator/agents/:slug/teams-identity/reset` — DESTRUCTIVE.
 *
 * Removes the Entra app registration (delete AND recycle-bin purge), the
 * Azure bot and the tenant catalog entry. What happens to the identity row
 * afterwards is the `scope`'s business — see {@link TeamsResetScope}.
 *
 * THE SCOPE IS ALWAYS SENT EXPLICITLY, including the default. The server
 * treats a missing one as `'run'` for the sake of clients written before
 * scopes existed, and relying on that here would make the destructive call
 * and the safe one differ by an omission rather than by a value — the kind of
 * difference that survives a refactor in the wrong direction.
 *
 * A PARTIAL TEARDOWN RESOLVES, IT DOES NOT REJECT. `status: 'incomplete'`
 * comes back as a 200 with the per-step report, because "which of the three
 * are still in Azure" is the answer the operator needs and an exception would
 * collapse it into "reset failed".
 */
export async function resetAgentTeamsIdentity(
  slug: string,
  scope: TeamsResetScope = 'run',
): Promise<ResetAgentTeamsIdentityResponse> {
  const dto = await callJson<ResetAgentTeamsIdentityResponse>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/teams-identity/reset`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope }),
    },
  );
  return { ...dto, steps: Array.isArray(dto.steps) ? dto.steps : [] };
}

export async function getAgentTeams(slug: string): Promise<AgentTeamsDto> {
  const dto = await callJson<AgentTeamsDto>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/teams`,
  );
  return {
    ...dto,
    teams: Array.isArray(dto.teams) ? dto.teams : [],
    capabilities: parseTeamsAssignmentCapabilities(dto.capabilities),
  };
}

export interface InstallAgentTeamResponse {
  ok: boolean;
  agent: string;
  team_id: string;
  state: string;
  /** True when the app was already installed in exactly this team — the POST
   *  is idempotent for that case and starts no second run. */
  already_installed: boolean;
  running: boolean;
}

/**
 * `POST /v1/operator/agents/:slug/teams` — record the target team and hand
 * the chain to the provisioning runner (202). Answers 409
 * `team_install_conflict` for a SECOND team: migration 0049 records one
 * `team_id`, and no uninstall exists, so re-targeting would leave an
 * untracked install behind.
 */
export async function installAgentTeam(
  slug: string,
  teamId: string,
  /** See `ProvisionTeamsIdentityInput.target_kind`. */
  targetKind?: TeamsTargetKind,
): Promise<InstallAgentTeamResponse> {
  return callJson<InstallAgentTeamResponse>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/teams`,
    {
      method: 'POST',
      body: JSON.stringify({
        team_id: teamId,
        ...(targetKind !== undefined ? { target_kind: targetKind } : {}),
      }),
    },
  );
}

/**
 * `DELETE /v1/operator/agents/:slug/teams/:teamId`.
 *
 * Gated on `capabilities.uninstall`, which is `false` for as long as
 * `teamsProvisioner@1` publishes no uninstall method — the route answers 501
 * `teams_uninstall_unsupported` then. The call exists so the panel is
 * capability-driven rather than hard-coded: the day the connector contract
 * gains an uninstall, the control lights up with no UI change.
 */
export interface UninstallAgentTeamResponse {
  ok: boolean;
  agent: string;
  team_id: string;
  /** `'uninstalled'` when this call removed the install, `'already-absent'`
   *  when the app was not in the team. Both are success. */
  outcome: 'uninstalled' | 'already-absent';
  already_absent: boolean;
  /** Provisioning state the row dropped back to (`catalog_uploaded`). */
  state: string;
}

export async function uninstallAgentTeam(
  slug: string,
  teamId: string,
): Promise<UninstallAgentTeamResponse> {
  return callJson<UninstallAgentTeamResponse>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/teams/${encodeURIComponent(teamId)}`,
    { method: 'DELETE' },
  );
}

/**
 * Machine codes the team-assignment routes emit as `{ error: '<code>' }`.
 *
 * A union of its own, like the identity routes': these add
 * `team_install_conflict` and the uninstall codes, which no other catalogue
 * on this page has copy for.
 *
 * `teams_uninstall_unsupported` is NOT dead now that the uninstall works: it
 * is what a middleware answers when the installed M365 connector is older
 * than 0.4.0 and publishes no `uninstallFromTeam`.
 *
 * i18n HARD RULE: none of these are user-facing text — each maps to a
 * `teamsInstalls.errors.*` key and the raw body never reaches the UI.
 */
export const TEAMS_ASSIGNMENT_ERROR_CODES = [
  'invalid_body',
  'invalid_slug',
  'multi_orchestrator_unavailable',
  'not_found',
  'team_install_conflict',
  'team_install_not_found',
  'teams_app_id_missing',
  'teams_identity_not_found',
  'teams_identity_unavailable',
  'teams_provisioner_unavailable',
  'teams_provisioning_running',
  'teams_uninstall_unsupported',
] as const;

export type TeamsAssignmentErrorCode =
  (typeof TEAMS_ASSIGNMENT_ERROR_CODES)[number];

const TEAMS_ASSIGNMENT_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  TEAMS_ASSIGNMENT_ERROR_CODES,
);

/** Same contract as {@link parseOperatorAgentErrorCode}: total, `null` for
 *  anything this client does not recognise. */
export function parseTeamsAssignmentErrorCode(
  err: unknown,
): TeamsAssignmentErrorCode | null {
  if (!(err instanceof ApiError)) return null;
  try {
    const parsed = JSON.parse(err.body) as { error?: unknown };
    return typeof parsed.error === 'string' &&
      TEAMS_ASSIGNMENT_ERROR_CODE_SET.has(parsed.error)
      ? (parsed.error as TeamsAssignmentErrorCode)
      : null;
  } catch {
    return null;
  }
}
