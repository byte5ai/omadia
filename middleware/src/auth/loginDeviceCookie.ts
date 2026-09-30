/**
 * Device cookie for the password sign-in limiter (docs/security-architecture.md
 * §10f) — the OWASP "device cookie" defence against lockout-DoS.
 *
 * Behind the web-ui proxy every browser reaches the middleware from the same
 * socket address, so the limiter's (account, client) pair collapses to "the
 * account": an attacker's wrong passwords would slow down the owner too. A
 * browser that has signed in to an account before carries this cookie, and
 * for THAT account the limiter keys it by the cookie's device id instead of
 * the shared address — the owner is never inside an attacker's budget.
 *
 * The cookie authenticates nothing. It only picks a rate-limit bucket, which
 * is why an HMAC is enough: the value is `v1.<id>.<exp>.<tag>` with
 * `tag = HMAC-SHA256(k, account \n id \n exp)`, where `k` is derived from the
 * session signing key for this one purpose. Bound to the account, so a cookie
 * minted for one account buys nothing on another; expires after
 * LOGIN_DEVICE_TTL_S. Minted fresh on every successful password sign-in and
 * on the first-user wizard; it survives logout on purpose.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Request, Response } from 'express';

import { isSecureContext } from './sessionCookie.js';

export const LOGIN_DEVICE_COOKIE = 'omadia_login_device';
/** One year: a device stays known across many sessions. */
export const LOGIN_DEVICE_TTL_S = 365 * 24 * 60 * 60;

const FORMAT = 'v1';
const ID_BYTES = 16;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const EXP_RE = /^\d{1,12}$/;
const TAG_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_COOKIE_LENGTH = 128;
const KEY_LABEL = 'omadia/login-device-cookie/v1';

export interface LoginDeviceCookies {
  /** A fresh cookie value for `accountKey`, valid LOGIN_DEVICE_TTL_S from `nowS`. */
  mint(accountKey: string, nowS?: number): string;
  /** The device id when `raw` is a genuine, unexpired cookie for exactly `accountKey`. */
  deviceIdFor(raw: unknown, accountKey: string, nowS?: number): string | null;
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function createLoginDeviceCookies(signingKey: Uint8Array): LoginDeviceCookies {
  // Domain separation: the raw key signs session JWTs; this sub-key signs
  // device cookies only, so neither value can stand in for the other.
  const key = createHmac('sha256', signingKey).update(KEY_LABEL).digest();
  const tagFor = (accountKey: string, id: string, exp: string): string =>
    createHmac('sha256', key).update(`${accountKey}\n${id}\n${exp}`).digest('base64url');

  return {
    mint(accountKey, nowS = epochSeconds()) {
      const id = randomBytes(ID_BYTES).toString('base64url');
      const exp = String(nowS + LOGIN_DEVICE_TTL_S);
      return `${FORMAT}.${id}.${exp}.${tagFor(accountKey, id, exp)}`;
    },
    deviceIdFor(raw, accountKey, nowS = epochSeconds()) {
      if (typeof raw !== 'string' || raw.length > MAX_COOKIE_LENGTH) return null;
      const [format, id, exp, tag, ...rest] = raw.split('.');
      if (format !== FORMAT || rest.length > 0) return null;
      if (!id || !exp || !tag) return null;
      if (!ID_RE.test(id) || !EXP_RE.test(exp) || !TAG_RE.test(tag)) return null;
      if (Number(exp) <= nowS) return null;
      const expected = Buffer.from(tagFor(accountKey, id, exp));
      const given = Buffer.from(tag);
      return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
    },
  };
}

/** Same attributes as the session cookie (HttpOnly, SameSite=Lax, Path=/, Secure behind TLS). */
export function setLoginDeviceCookie(req: Request, res: Response, value: string): void {
  res.cookie(LOGIN_DEVICE_COOKIE, value, {
    httpOnly: true,
    secure: isSecureContext(req),
    sameSite: 'lax',
    maxAge: LOGIN_DEVICE_TTL_S * 1000,
    path: '/',
  });
}
