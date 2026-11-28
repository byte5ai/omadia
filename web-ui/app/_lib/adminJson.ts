import { ApiError, rscTimeoutSignal } from './api';

/**
 * #2320 — one JSON caller for the admin keychain, skills, sandbox and
 * publish clients (`adminCredentials.ts`, `adminSkills.ts`,
 * `adminSandboxes.ts`, `adminPublish.ts`). `_lib/api.ts` keeps its own
 * `getJson`/`postJson` file-private, so the browser path is inlined here once
 * instead of in each client (same shape as `agentChannelIdentities.ts`).
 *
 * The admin pages are client components: in the browser every call goes
 * through the `/bot-api` proxy with the session cookie.
 */

function botApi(path: string): string {
  if (typeof window !== 'undefined') return `/bot-api${path}`;
  const base = process.env['MIDDLEWARE_URL'] ?? 'http://localhost:3979';
  return `${base}/api${path}`;
}

export async function adminJson<T>(
  path: string,
  init: { readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; readonly body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const res = await fetch(botApi(path), {
    method,
    headers: {
      accept: 'application/json',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: method === 'GET' ? rscTimeoutSignal() : undefined,
    cache: 'no-store',
    credentials: 'include',
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(res.status, `${method} ${path} failed: ${res.status}`, text);
  }
  // A 204 (e.g. DELETE of an agent credential grant) has no body.
  if (res.status === 204) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, `${method} ${path}: response is not JSON`, text);
  }
}

/** The array under `key`, or an `ApiError` the page's catch can render. */
export function arrayField<T>(body: unknown, key: string, path: string): T[] {
  const value = (body as Record<string, unknown> | null)?.[key];
  if (Array.isArray(value)) return value as T[];
  throw new ApiError(200, `GET ${path}: malformed body — "${key}" is not an array`);
}
