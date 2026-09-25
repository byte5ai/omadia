import type { Request, Response } from 'express';

import { SESSION_COOKIE } from './requireAuth.js';

/**
 * Lifetime of ONE session window, in seconds. Every login mints a window
 * of this length; a renewal (#965) mints another one, clamped to the
 * absolute cap (`AUTH_SESSION_MAX_LIFETIME_HOURS`, measured from
 * `auth_time`). The cap's lower bound in `config.ts` equals this value, so
 * a login window never outlives the cap.
 */
export const SESSION_WINDOW_S = 4 * 60 * 60;

/** True when the request reached us over TLS (Fly terminates TLS and
 *  forwards `x-forwarded-proto`). Drives the cookie `secure` flag. */
export function isSecureContext(req: Request): boolean {
  const proto = req.headers['x-forwarded-proto'];
  if (Array.isArray(proto)) return proto[0] === 'https';
  return proto === 'https';
}

/**
 * Write the session cookie. Single place for its attributes so the login
 * paths and `POST /renew` cannot drift apart (httpOnly, sameSite=lax,
 * path=/, secure behind TLS).
 */
export function setSessionCookie(
  req: Request,
  res: Response,
  token: string,
  maxAgeSeconds: number,
): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureContext(req),
    sameSite: 'lax',
    maxAge: Math.max(0, maxAgeSeconds) * 1000,
    path: '/',
  });
}
