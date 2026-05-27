import { ApiError } from './api';

/**
 * Typed client for the operator channels REST surface (Phase B+).
 *
 * Mirrors the agents.ts pattern: each export wraps the corresponding
 * `/api/v1/operator/channels/*` endpoint. `botApi` + `forwardCookieHeader`
 * are inlined here (same reason as in `agents.ts` — `_lib/api.ts` keeps
 * those file-private).
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

export interface OperatorChannelDto {
  channel_type: string;
  channel_key: string;
  label: string;
  hint?: string;
  origin_plugin_id: string;
  bound_agent_slug: string | null;
  stale: boolean;
}

export interface ChannelsListDto {
  channels: OperatorChannelDto[];
  agents: Array<{ slug: string; name: string }>;
  fallback_slug: string | null;
  directory_types: string[];
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

export async function listOperatorChannels(): Promise<ChannelsListDto> {
  return callJson<ChannelsListDto>('/v1/operator/channels');
}

export async function setChannelBinding(
  channel_type: string,
  channel_key: string,
  agent_slug: string | null,
): Promise<void> {
  await callJson('/v1/operator/channels/binding', {
    method: 'PUT',
    body: JSON.stringify({ channel_type, channel_key, agent_slug }),
  });
}

export async function clearChannelBinding(
  channel_type: string,
  channel_key: string,
): Promise<void> {
  await callJson('/v1/operator/channels/binding', {
    method: 'DELETE',
    body: JSON.stringify({ channel_type, channel_key }),
  });
}
