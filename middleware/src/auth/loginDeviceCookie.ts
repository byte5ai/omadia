/**
 * Device cookie for the password sign-in limiter (docs/security-architecture.md
 * §10f) — the OWASP "device cookie" defence against lockout-DoS.
 *
 * Behind the web-ui proxy every browser reaches the middleware from the same
 * socket address, so the limiter's (account, client) pair collapses to "the
 * account": an attacker's wrong passwords would slow down the owner too. A
 * browser that has signed in to an account carries this cookie, and for THAT
 * account the limiter counts it among the account's known browsers instead of
 * keying it by the shared address.
 *
 * The cookie authenticates nothing; it only picks a rate-limit bucket. Its
 * value is `v2.<id>.<exp>.<ep>.<tag>`:
 *
 *   id   the device id: random on a password sign-in, derived from the
 *        sign-in time for `GET /me` (`sessionDeviceId`), so one sign-in
 *        yields one id however often `/me` is called;
 *   exp  expiry, epoch seconds, LOGIN_DEVICE_TTL_S after minting;
 *   ep   a fingerprint of the account's credential epoch at minting time
 *        (`./loginDevices.ts`). A password reset or a deleted account changes
 *        the epoch, which leaves every older cookie stale;
 *   tag  HMAC-SHA256 over account, id, exp and ep.
 *
 * This module only checks the tag and the expiry (`read`); comparing `ep`
 * with the account's current epoch is `isCurrent`, which needs a lookup.
 * All three keys are derived from the session signing key, one per purpose,
 * so rotating that key revokes every device cookie together with every
 * session.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Request, Response } from 'express';

import { isSecureContext } from './sessionCookie.js';

export const LOGIN_DEVICE_COOKIE = 'omadia_login_device';
/** One year: a device stays known across many sessions. */
export const LOGIN_DEVICE_TTL_S = 365 * 24 * 60 * 60;

const FORMAT = 'v2';
const ID_BYTES = 16;
/** 16 bytes (an id) or a 132-bit truncated MAC (a fingerprint), base64url. */
const SHORT_RE = /^[A-Za-z0-9_-]{22}$/;
const SHORT_LENGTH = 22;
const EXP_RE = /^\d{1,12}$/;
const TAG_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_COOKIE_LENGTH = 128;
const KEY_LABEL = 'omadia/login-device-cookie/v2';

/** A cookie whose tag and expiry check out for one account. */
export interface LoginDeviceCookie {
  readonly id: string;
  /** Fingerprint of the epoch it was minted under — see `isCurrent`. */
  readonly ep: string;
}

export interface LoginDeviceCookies {
  /** A cookie value for `accountKey` under its current `epoch`; a random id unless `id` is given. */
  mint(accountKey: string, epoch: string, opts?: { id?: string; nowS?: number }): string;
  /** The cookie when `raw` is genuine and unexpired for exactly `accountKey`, else null. */
  read(raw: unknown, accountKey: string, nowS?: number): LoginDeviceCookie | null;
  /** Whether a read cookie was minted under `epoch`. */
  isCurrent(cookie: LoginDeviceCookie, epoch: string): boolean;
  /** The device id of one sign-in: the same for every call with the same `authTime`. */
  sessionDeviceId(accountKey: string, authTime: number): string;
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function equalStrings(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createLoginDeviceCookies(signingKey: Uint8Array): LoginDeviceCookies {
  // Domain separation: the raw key signs session JWTs; each sub-key below
  // serves one purpose only, so no value can stand in for another.
  const subKey = (purpose: string): Buffer =>
    createHmac('sha256', signingKey).update(`${KEY_LABEL}/${purpose}`).digest();
  const tagKey = subKey('tag');
  const epochKey = subKey('epoch');
  const idKey = subKey('session-id');
  const mac = (key: Buffer, message: string): string =>
    createHmac('sha256', key).update(message).digest('base64url');

  const fingerprint = (epoch: string): string => mac(epochKey, epoch).slice(0, SHORT_LENGTH);
  const tagFor = (accountKey: string, id: string, exp: string, ep: string): string =>
    mac(tagKey, `${accountKey}\n${id}\n${exp}\n${ep}`);

  return {
    mint(accountKey, epoch, opts = {}) {
      const id = opts.id ?? randomBytes(ID_BYTES).toString('base64url');
      if (!SHORT_RE.test(id)) throw new Error('device id must be 22 base64url characters');
      const exp = String((opts.nowS ?? epochSeconds()) + LOGIN_DEVICE_TTL_S);
      const ep = fingerprint(epoch);
      return `${FORMAT}.${id}.${exp}.${ep}.${tagFor(accountKey, id, exp, ep)}`;
    },
    read(raw, accountKey, nowS = epochSeconds()) {
      if (typeof raw !== 'string' || raw.length > MAX_COOKIE_LENGTH) return null;
      const [format, id, exp, ep, tag, ...rest] = raw.split('.');
      if (format !== FORMAT || rest.length > 0) return null;
      if (!id || !exp || !ep || !tag) return null;
      if (!SHORT_RE.test(id) || !EXP_RE.test(exp) || !SHORT_RE.test(ep) || !TAG_RE.test(tag)) {
        return null;
      }
      if (Number(exp) <= nowS) return null;
      return equalStrings(tag, tagFor(accountKey, id, exp, ep)) ? { id, ep } : null;
    },
    isCurrent(cookie, epoch) {
      return equalStrings(cookie.ep, fingerprint(epoch));
    },
    sessionDeviceId(accountKey, authTime) {
      return mac(idKey, `${accountKey}\n${String(authTime)}`).slice(0, SHORT_LENGTH);
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
