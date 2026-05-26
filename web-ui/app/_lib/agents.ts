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
