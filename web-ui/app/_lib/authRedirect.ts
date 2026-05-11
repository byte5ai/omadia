import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { ApiError } from './api';

/**
 * RSC catch-block helper. If the error is a 401/403 from the API, bounce
 * the user to /login with the original path as `return`. Otherwise no-op.
 *
 * Layer 2 of the auth-redirect chain. The edge middleware (decode-only
 * JWT check) handles missing + expired cookies. This helper covers the
 * residual case where a cookie has a future `exp` but a signature the
 * backend rejects (key rotation, forged token, claims mismatch).
 *
 * Usage:
 *   try {
 *     plugins = await listStorePlugins();
 *   } catch (err) {
 *     await redirectIfUnauthorized(err);
 *     loadError = err instanceof Error ? err.message : 'Unbekannter Fehler';
 *   }
 *
 * `redirect()` throws NEXT_REDIRECT — when called inside a catch block,
 * the throw escapes the catch and propagates to the framework. The
 * `loadError` line only runs for non-auth errors.
 */
export async function redirectIfUnauthorized(err: unknown): Promise<void> {
  if (!(err instanceof ApiError)) return;
  if (err.status !== 401 && err.status !== 403) return;
  const h = await headers();
  const pathname = h.get('x-pathname') ?? '/';
  redirect(`/login?return=${encodeURIComponent(pathname)}`);
}
