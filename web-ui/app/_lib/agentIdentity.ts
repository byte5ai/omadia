/**
 * Typed client for the agent identity surface (#914) —
 * `/api/v1/operator/agents/:slug/identity*` in `routes/operatorAgents.ts`.
 *
 * The identity of a DEPLOYED agent: what it is called, what it says about
 * itself, how it behaves, what colour and face it wears. It
 * has nothing to do with the Agent Builder, which authors agent PLUGINS —
 * that separation is the whole point of the issue, so this module does not
 * import from, link to, or fall back on anything builder-shaped.
 *
 * TWO VIEWS OF THE SAME THING, ON PURPOSE. `identity` carries the AUTHORED
 * values (nullable — an empty field means "inherit"); `resolved` carries what
 * consumers actually see. The form edits the first and previews the second;
 * neither is derived here, because the server already resolved it once and a
 * second implementation would eventually disagree with it.
 *
 * `botApi` + `forwardCookieHeader` mirror `_lib/agents.ts` verbatim, for the
 * reason stated there (they are file-private in `_lib/api.ts`).
 */

import { ApiError } from './api';
import type { QualityConfig } from './builderTypes';
import type { PersonaConfig } from './personaTypes';

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

// ---------------------------------------------------------------------------
// DTOs — snake_case, verbatim from the REST payload
// ---------------------------------------------------------------------------

/** The authored identity. `null` in a field = not authored, inherited. */
export interface AgentIdentityFieldsDto {
  display_name: string | null;
  short_description: string | null;
  long_description: string | null;
  instructions: string | null;
  accent_color: string | null;
  /** The 12-axis character block — same shape the Agent Builder writes. */
  persona: PersonaConfig | null;
  /** Boundaries + sycophancy — same shape the Agent Builder writes. */
  quality: QualityConfig | null;
  revision: number;
  avatar: { etag: string; url: string } | null;
  updated_at: string | null;
}

/** What consumers see once the fallbacks are applied. */
export interface AgentIdentityResolvedDto {
  display_name: string;
  short_description: string | null;
  long_description: string | null;
  instructions: string | null;
  accent_color: string | null;
  has_avatar: boolean;
}

export interface AgentIdentityDto {
  slug: string;
  identity: AgentIdentityFieldsDto;
  resolved: AgentIdentityResolvedDto;
  /**
   * The system prompt this identity currently compiles to — instructions,
   * persona traits, boundaries and the sycophancy guard in one text. Read
   * only: it is derived, and showing it is what turns twelve sliders from a
   * guess into something an operator can check.
   */
  composed_prompt: string | null;
  /** Model family the persona deltas were compiled against. */
  composed_family: string | null;
}

/** What a write did to the agent's published Teams package. */
export const AGENT_IDENTITY_REPUBLISH_OUTCOMES = [
  'queued',
  'not_needed',
  'no_installed_app',
  'provisioner_unavailable',
] as const;

export type AgentIdentityRepublishOutcome =
  (typeof AGENT_IDENTITY_REPUBLISH_OUTCOMES)[number];

const REPUBLISH_SET = new Set<string>(AGENT_IDENTITY_REPUBLISH_OUTCOMES);

/**
 * Narrow the server's republish signal. An unrecognised value resolves to
 * `not_needed` — the branch that renders NOTHING. A UI that guessed
 * "queued" from an unknown code would tell the operator their edit is on its
 * way to Teams without any evidence that it is.
 */
export function parseRepublishOutcome(
  raw: unknown,
): AgentIdentityRepublishOutcome {
  return typeof raw === 'string' && REPUBLISH_SET.has(raw)
    ? (raw as AgentIdentityRepublishOutcome)
    : 'not_needed';
}

export interface AgentIdentityWriteDto extends AgentIdentityDto {
  republish: AgentIdentityRepublishOutcome;
  /** Avatar upload only: whether an outline icon could be derived. */
  outline_derived?: boolean;
  /** Boundary preset ids the server could not resolve — a rule that stopped
   *  applying, surfaced instead of dropped. */
  dropped_boundary_presets?: readonly string[];
}

/** Everything a PUT replaces wholesale. */
export interface AgentIdentityInput {
  display_name: string | null;
  short_description: string | null;
  long_description: string | null;
  instructions: string | null;
  accent_color: string | null;
  persona: PersonaConfig | null;
  quality: QualityConfig | null;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

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

function identityPath(slug: string, suffix = ''): string {
  return `/v1/operator/agents/${encodeURIComponent(slug)}/identity${suffix}`;
}

export async function getAgentIdentity(slug: string): Promise<AgentIdentityDto> {
  return callJson<AgentIdentityDto>(identityPath(slug));
}

/** Replace the authored fields. A `null` clears one back to inherited. */
export async function saveAgentIdentity(
  slug: string,
  input: AgentIdentityInput,
): Promise<AgentIdentityWriteDto> {
  const res = await callJson<AgentIdentityWriteDto>(identityPath(slug), {
    method: 'PUT',
    body: JSON.stringify(input),
  });
  return { ...res, republish: parseRepublishOutcome(res.republish) };
}

/** Image types the upload route accepts — also the file picker's filter. */
export const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp';

/**
 * Upload one image as the agent's avatar. Sent as a RAW body with the file's
 * own content type — the route parses exactly that, and multipart would add a
 * boundary parser to a request that carries a single file and nothing else.
 */
export async function uploadAgentAvatar(
  slug: string,
  file: Blob,
): Promise<AgentIdentityWriteDto> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(botApi(identityPath(slug, '/avatar')), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': file.type,
      ...forwarded,
    },
    body: file,
    cache: 'no-store',
    credentials: 'include',
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `POST ${identityPath(slug, '/avatar')} failed: ${res.status}`,
      text,
    );
  }
  const parsed = JSON.parse(text) as AgentIdentityWriteDto;
  return { ...parsed, republish: parseRepublishOutcome(parsed.republish) };
}

export async function deleteAgentAvatar(
  slug: string,
): Promise<AgentIdentityWriteDto> {
  const res = await callJson<AgentIdentityWriteDto>(
    identityPath(slug, '/avatar'),
    { method: 'DELETE' },
  );
  return { ...res, republish: parseRepublishOutcome(res.republish) };
}

/**
 * Browser URL for the avatar preview, or `null` when there is no avatar.
 *
 * The server returns a same-origin MIDDLEWARE path (`/api/v1/...`); the
 * browser reaches the middleware through the `/bot-api` proxy prefix, exactly
 * as {@link botApi} does for every other call in this module. The etag rides
 * along as a query parameter because the replaced picture is already cached
 * under the same path — without it, an operator who just uploaded a new
 * avatar would keep looking at the old one.
 */
export function avatarPreviewUrl(
  identity: AgentIdentityFieldsDto,
): string | null {
  if (!identity.avatar) return null;
  const path = identity.avatar.url.replace(/^\/api\//, '/bot-api/');
  return `${path}?v=${identity.avatar.etag.slice(0, 16)}`;
}
