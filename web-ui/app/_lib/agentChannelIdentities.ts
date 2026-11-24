import { ApiError, rscTimeoutSignal } from './api';

/**
 * Typed client for an agent's own bots on channels other than Teams
 * (spec 2042 §5.3): `GET/PUT/DELETE /v1/operator/agents/:slug/channel-identities`.
 *
 * The channel plugin declares what the operator enters (a bot token, an app
 * id); the kernel hands it over once and never returns a credential. The
 * routing key and the bot's public name are all that comes back.
 *
 * `botApi` + `forwardCookieHeader` are inlined for the same reason as in
 * `channels.ts` (`_lib/api.ts` keeps them file-private).
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

async function callJson<T>(path: string, init?: RequestInit & { method?: string }): Promise<T> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(botApi(path), {
    ...init,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...forwarded,
      ...(init?.headers ?? {}),
    },
    signal: (init?.method ?? 'GET') === 'GET' ? rscTimeoutSignal(init) : init?.signal,
    cache: 'no-store',
    credentials: 'include',
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(res.status, `${init?.method ?? 'GET'} ${path} failed: ${res.status}`, text);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

/** Per-locale text a channel plugin declares; `en` is always present. */
export type LocalizedText = Readonly<Record<string, string>> & { readonly en: string };

export interface ChannelIdentityFieldDto {
  readonly key: string;
  readonly label: LocalizedText;
  readonly help?: LocalizedText;
  readonly secret: boolean;
  readonly required?: boolean;
}

export const CHANNEL_IDENTITY_STATES = ['running', 'stopped', 'unknown'] as const;
export type ChannelIdentityState = (typeof CHANNEL_IDENTITY_STATES)[number];

export interface ChannelIdentityDto {
  readonly channelType: string;
  readonly channelKey: string;
  readonly externalRef: string | null;
  readonly displayName: string | null;
  readonly createdAt: string;
  readonly status: { readonly state: ChannelIdentityState; readonly detail?: string };
}

export interface ChannelIdentityChannelDto {
  readonly channelType: string;
  readonly fields: readonly ChannelIdentityFieldDto[];
  readonly identity: ChannelIdentityDto | null;
}

export interface ChannelIdentitiesDto {
  readonly agent: string;
  readonly channels: readonly ChannelIdentityChannelDto[];
}

/** Error codes the route answers with; anything else renders the fallback. */
export const CHANNEL_IDENTITY_ERROR_CODES = [
  'agent_identities_unavailable',
  'not_found',
  'invalid_channel_type',
  'channel_not_available',
  'invalid_input',
  'agent_has_identity',
  'invalid_credentials',
  'already_in_use',
  'bot_taken',
  'unreachable',
  'invalid_key',
  'identity_not_found',
] as const;
export type ChannelIdentityErrorCode = (typeof CHANNEL_IDENTITY_ERROR_CODES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set(CHANNEL_IDENTITY_ERROR_CODES);

export function parseChannelIdentityErrorCode(err: unknown): ChannelIdentityErrorCode | null {
  if (!(err instanceof ApiError) || err.code === null) return null;
  return ERROR_CODE_SET.has(err.code) ? (err.code as ChannelIdentityErrorCode) : null;
}

/** The text for the active locale, else English. */
export function localizedText(text: LocalizedText, locale: string): string {
  const base = locale.split('-')[0] ?? locale;
  return text[locale] ?? text[base] ?? text.en;
}

function parseState(raw: unknown): ChannelIdentityState {
  return CHANNEL_IDENTITY_STATES.includes(raw as ChannelIdentityState) ? (raw as ChannelIdentityState) : 'unknown';
}

/** Narrow at the boundary: a channel without a usable shape is dropped. */
export function normalizeChannelIdentities(dto: ChannelIdentitiesDto): ChannelIdentitiesDto {
  const channels = Array.isArray(dto.channels) ? dto.channels : [];
  return {
    agent: dto.agent,
    channels: channels
      .filter((c: ChannelIdentityChannelDto) => typeof c?.channelType === 'string')
      .map((c) => ({
        channelType: c.channelType,
        fields: Array.isArray(c.fields)
          ? c.fields.filter((f: ChannelIdentityFieldDto) => typeof f?.key === 'string' && typeof f?.label?.en === 'string')
          : [],
        identity: c.identity
          ? { ...c.identity, status: { ...c.identity.status, state: parseState(c.identity.status?.state) } }
          : null,
      })),
  };
}

const base = (slug: string): string => `/v1/operator/agents/${encodeURIComponent(slug)}/channel-identities`;

export async function getAgentChannelIdentities(slug: string): Promise<ChannelIdentitiesDto> {
  return normalizeChannelIdentities(await callJson<ChannelIdentitiesDto>(base(slug)));
}

export async function setAgentChannelIdentity(
  slug: string,
  channelType: string,
  credentials: Readonly<Record<string, string>>,
): Promise<{ ok: boolean; identity: ChannelIdentityDto }> {
  return callJson(`${base(slug)}/${encodeURIComponent(channelType)}`, {
    method: 'PUT',
    body: JSON.stringify({ credentials }),
  });
}

export async function removeAgentChannelIdentity(
  slug: string,
  channelType: string,
): Promise<{ ok: boolean; released: boolean }> {
  return callJson(`${base(slug)}/${encodeURIComponent(channelType)}`, { method: 'DELETE' });
}
