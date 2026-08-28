import { ApiError } from './api';
import type { LocalizedMarkdown } from './storeTypes';

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

// ── W5 memory-ACL rollout switch (#899) ────────────────────────────────

/**
 * The three modes `agents.context_memory` accepts. Structural contract with
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

// ── W2a (#860) — per-agent Teams bot identity ──────────────────────────

/**
 * Provisioning-chain vocabulary, mirroring `TEAMS_PROVISIONING_STATES` in
 * `middleware/src/platform/agentTeamsIdentityStore.ts` (itself the CHECK
 * constraint of migration 0049, verbatim). Structural contract, same
 * arrangement as {@link FALLBACK_AGENT_SLUG}: the middleware owns the
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
  raw: string;
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
  const rawText = obj?.['raw'];
  return {
    code,
    ...(scopes ? { scopes } : {}),
    ...(fields ? { fields } : {}),
    ...(typeof retry === 'number' && Number.isFinite(retry)
      ? { retryAfterSeconds: retry }
      : {}),
    ...(typeof reason === 'string' && reason !== '' ? { reason } : {}),
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
): Promise<InstallAgentTeamResponse> {
  return callJson<InstallAgentTeamResponse>(
    `/v1/operator/agents/${encodeURIComponent(slug)}/teams`,
    { method: 'POST', body: JSON.stringify({ team_id: teamId }) },
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
