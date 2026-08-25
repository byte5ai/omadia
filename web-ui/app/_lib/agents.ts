import { ApiError } from './api';

/**
 * Typed client for the operator multi-orchestrator REST surface
 * (`/api/v1/operator/agents/*` — see `routes/operatorAgents.ts` in the
 * middleware). Used by `app/operator/agents/page.tsx` (RSC fetches) and
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
  privacy_profile: PrivacyProfile;
  status: AgentStatus;
  created_at: string;
  updated_at: string;
  active: boolean;
  memory_scope: string[];
  plugins: OperatorAgentPluginDto[];
  bindings: OperatorAgentBindingDto[];
}

export interface OperatorAgentsListDto {
  agents: OperatorAgentDto[];
  fallback_agent_id: string | null;
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

export async function listOperatorAgents(): Promise<OperatorAgentsListDto> {
  return callJson<OperatorAgentsListDto>('/v1/operator/agents');
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
  privacy_profile?: PrivacyProfile;
  status?: AgentStatus;
}

export async function createOperatorAgent(input: CreateAgentInput): Promise<{
  id: string;
  slug: string;
}> {
  return callJson('/v1/operator/agents', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export interface PatchAgentInput {
  name?: string;
  description?: string | null;
  privacy_profile?: PrivacyProfile;
  status?: AgentStatus;
}

export async function patchOperatorAgent(
  slug: string,
  patch: PatchAgentInput,
): Promise<void> {
  await callJson(`/v1/operator/agents/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deleteOperatorAgent(slug: string): Promise<void> {
  await callJson(`/v1/operator/agents/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
  });
}

// ── W0c (#861) — per-agent plugin assignment + grant read model ─────────

export interface AgentPluginsDto {
  slug: string;
  /** True when this agent is the platform fallback (its plugins always run
   *  with the global store config). */
  fallback: boolean;
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
  fallback: boolean;
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
 * `{ error: '<code>' }` (they predate the `{ code }` envelope `ApiError.code`
 * parses, so the code must be read from the body).
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

export async function setFallbackAgent(slug: string | null): Promise<void> {
  await callJson('/v1/operator/agents/fallback', {
    method: 'PUT',
    body: JSON.stringify({ slug }),
  });
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
  privacy_profile: PrivacyProfile;
  is_fallback: boolean;
}

export interface EnabledAgentsListDto {
  agents: EnabledAgentDto[];
  fallback_slug: string | null;
}

/**
 * Minimal-metadata list of enabled Agents for the chat header picker
 * (Phase A). Does NOT reveal plugin/binding internals. Backed by
 * `GET /api/v1/operator/agents/enabled` in the middleware.
 */
export async function listEnabledAgents(): Promise<EnabledAgentsListDto> {
  return callJson<EnabledAgentsListDto>('/v1/operator/agents/enabled');
}

// ── Phase B — operator dashboard support surfaces ───────────────────────

export type PluginKind =
  | 'agent'
  | 'integration'
  | 'channel'
  | 'tool'
  | 'extension';

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
  label: string;
  type: SetupFieldType;
  help?: string;
  default?: string | string[];
  enum?: Array<{ value: string; label: string }>;
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
    privacy_profile: PrivacyProfile;
  } | null;
  via: 'binding' | 'fallback' | 'none';
  message?: string;
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
 * B3d — re-attach every installed plugin to the current fallback Agent.
 * Idempotent on the server; returns the attached count.
 */
export async function rehydrateFallback(): Promise<{
  ok: boolean;
  slug: string;
  attached: number;
  requested: number;
}> {
  return callJson('/v1/operator/agents/fallback/rehydrate', {
    method: 'POST',
  });
}

/**
 * Slug of the auto-seeded fallback orchestrator (kept in sync with
 * `FALLBACK_AGENT_SLUG` in `@omadia/orchestrator`). The fallback orchestrator
 * is the catch-all for unbound channel traffic, so its Disable/Delete actions
 * are blocked in the UI (and server-side). Treat an orchestrator as the
 * protected fallback when it carries this slug OR is the active platform
 * fallback pointer — the platform pointer may be intentionally unset while the
 * seeded `fallback` row still exists. Shared by the dashboard and the agent
 * detail route (issue #861) so the two never disagree on who the fallback is.
 */
export const FALLBACK_AGENT_SLUG = 'fallback';

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
