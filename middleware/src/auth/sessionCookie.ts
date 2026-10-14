import type { Request, Response } from 'express';

import { requestIsSecure } from '../http/requestTrust.js';
import { SESSION_COOKIE } from './requireAuth.js';

/**
 * Lifetime of ONE session window, in seconds. Every login mints a window
 * of this length; a renewal (#965) mints another one, clamped to the
 * absolute cap (`AUTH_SESSION_MAX_LIFETIME_HOURS`, measured from
 * `auth_time`). The cap's lower bound in `config.ts` equals this value, so
 * a login window never outlives the cap.
 */
export const SESSION_WINDOW_S = 4 * 60 * 60;

/**
 * Write the session cookie. Single place for its attributes so the login
 * paths and `POST /renew` cannot drift apart (httpOnly, sameSite=lax,
 * path=/, and `Secure` whenever `requestIsSecure` says the request arrived
 * over TLS — `req.secure` under the default `PUBLIC_SCHEME=auto`, never a raw
 * `X-Forwarded-Proto` (#1310, §10o)).
 */
export function setSessionCookie(
  req: Request,
  res: Response,
  token: string,
  maxAgeSeconds: number,
): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: requestIsSecure(req),
    sameSite: 'lax',
    maxAge: Math.max(0, maxAgeSeconds) * 1000,
    path: '/',
  });
}
