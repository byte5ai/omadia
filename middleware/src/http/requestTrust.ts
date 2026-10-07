/**
 * Who may speak for the client, and what scheme clients reach us over
 * (`TRUSTED_PROXY_ADDRESSES`, `PUBLIC_SCHEME`; issue #1310,
 * docs/security-architecture.md §10o).
 *
 * `X-Forwarded-Proto`, `X-Forwarded-For` and `X-Forwarded-Host` are ordinary
 * request headers: anything that can reach the server can send them. They are
 * worth reading only to the extent that a hop the operator vouches for wrote
 * them, and Express decides that with one setting, `trust proxy`.
 *
 * It used to be `true` — trust every hop — and `isSecureContext` did not even
 * go through Express: it read `req.headers['x-forwarded-proto']` directly and
 * its answer is the `Secure` flag on the session cookie, the login-device
 * cookie and the OIDC PKCE cookie. The sender of a request therefore chose
 * whether its own auth cookies were marked TLS-only.
 *
 * A hop COUNT does not fix that, which is why this module takes addresses
 * only. Express's numeric setting trusts the n addresses nearest the server
 * COUNTING THE IMMEDIATE PEER, so a client connecting directly is itself
 * trusted hop #1 and its header is believed. Measured against the `express` in
 * this workspace — a direct loopback client over plain HTTP sending
 * `x-forwarded-proto: https`:
 *
 *   trust proxy = true          → req.secure true
 *   trust proxy = 1             → req.secure true
 *   trust proxy = 2             → req.secure true
 *   trust proxy = 'loopback'    → req.secure true
 *   trust proxy = ['10.1.2.3']  → req.secure FALSE
 *   trust proxy = false         → req.secure FALSE
 *
 * Only naming the proxy refuses the forgery, so the default is the empty
 * list: trust nothing until an operator names the hop in front of this process.
 *
 * `PUBLIC_SCHEME` is the second half, and it is one setting rather than a
 * cookie-only flag on purpose. Narrowing `trust proxy` cannot close the
 * reporter's first failure mode — a proxy that terminates TLS and sets no
 * `X-Forwarded-Proto` leaves `req.secure` false under EVERY value in the table
 * above, because nothing distinguishes it from genuine plain HTTP. The
 * operator has to say. And the same statement governs every scheme-shaped
 * decision in the process, not only the cookie flag: the pairing descriptor
 * hands clients `https`/`wss` login and canvas URLs, and a deployment that
 * declares HTTPS for its cookies must advertise HTTPS there too, or an HTTPS
 * page gets a `ws://` URL its browser blocks as mixed content.
 *
 * Related trust boundaries this deliberately does NOT widen: the password
 * sign-in limiter reads its own policy and never `req.ip`
 * (`../auth/clientAddress.ts`, §10m), and the dev-endpoint gate reads the
 * socket peer (`../auth/loopbackOnly.ts`, §10).
 */

import { isIP } from 'node:net';

import type { Request } from 'express';

/** Exactly what `app.set('trust proxy', …)` is given. `false` = trust no hop. */
export type TrustedProxySetting = false | readonly string[];

/**
 * Express's named subnet aliases. Accepted because the shipped desktop
 * topology really is a loopback hop, and rejecting them would push operators
 * back to `true`.
 */
const SUBNET_ALIASES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** More hops than any shipped topology has; beyond this it is a paste error. */
export const MAX_TRUSTED_PROXIES = 16;

/** `none` spelled out, for an operator who prefers a word to a blank. */
const EXPLICIT_NONE = 'none';

export function parseTrustedProxies(raw: string): TrustedProxySetting {
  const value = raw.trim();
  if (value === '' || value.toLowerCase() === EXPLICIT_NONE) return false;
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return false;
  if (entries.length > MAX_TRUSTED_PROXIES) {
    throw new Error(
      `TRUSTED_PROXY_ADDRESSES takes at most ${String(MAX_TRUSTED_PROXIES)} entries (got ${String(entries.length)})`,
    );
  }
  for (const entry of entries) {
    if (SUBNET_ALIASES.has(entry.toLowerCase())) continue;
    if (/^\d+$/.test(entry)) {
      throw new Error(
        `TRUSTED_PROXY_ADDRESSES takes addresses, not a hop count (got ${JSON.stringify(entry)}). ` +
          'A hop count trusts the immediate peer, so a client connecting directly is trusted hop #1 ' +
          'and its X-Forwarded-Proto is believed — name the proxy address instead.',
      );
    }
    if (!isAddressOrBlock(entry)) {
      throw new Error(
        `TRUSTED_PROXY_ADDRESSES entry must be an IP, an IP/bits block, or loopback|linklocal|uniquelocal (got ${JSON.stringify(entry)})`,
      );
    }
  }
  return entries.map((entry) =>
    SUBNET_ALIASES.has(entry.toLowerCase()) ? entry.toLowerCase() : entry,
  );
}

/** Boolean form for the zod schema, so a bad value is a config error, not a throw. */
export function isTrustedProxyList(raw: string): boolean {
  try {
    parseTrustedProxies(raw);
    return true;
  } catch {
    return false;
  }
}

/** The setting in its env spelling, for the boot log line. */
export function describeTrustedProxies(setting: TrustedProxySetting): string {
  return setting === false ? EXPLICIT_NONE : setting.join(',');
}

/**
 * `PUBLIC_SCHEME` — the scheme clients reach this deployment over.
 *
 *   auto   follow the connection (`req.secure`): the socket's own TLS state,
 *          plus `X-Forwarded-Proto` from the hops `TRUSTED_PROXY_ADDRESSES`
 *          names, and from no other hop. The default.
 *   https  clients reach us over TLS whatever this process can observe. For a
 *          reverse proxy that terminates TLS but sets no `X-Forwarded-Proto`,
 *          where `auto` cannot tell that apart from genuine plain HTTP and the
 *          alternative — believing the header from everyone — is the bug this
 *          replaced.
 *   http   plain HTTP on purpose, with no doubt about it.
 */
export const PUBLIC_SCHEME_MODES = ['auto', 'https', 'http'] as const;
export type PublicSchemeMode = (typeof PUBLIC_SCHEME_MODES)[number];

export function isPublicSchemeMode(raw: string): raw is PublicSchemeMode {
  return (PUBLIC_SCHEME_MODES as readonly string[]).includes(raw.trim());
}

/**
 * Express app setting `PUBLIC_SCHEME` is stored under at boot.
 *
 * An app setting rather than a module-level variable: the readers keep a
 * one-argument signature, the value travels with the app rather than with the
 * process, and a test can stand up two apps with different modes without
 * resetting global state between them. An app that never set it gets `auto`.
 *
 * The string is also read by `@omadia/ui-channel`, which keeps zero runtime
 * deps on the kernel and so spells the key literally — same arrangement as its
 * copy of `CANVAS_PATH`. Changing it here means changing it there.
 */
export const PUBLIC_SCHEME_SETTING = 'omadia:public-scheme';

/**
 * True when this request must be treated as having arrived over TLS — the
 * cookie `Secure` flag, and the `https`/`wss` in the pairing descriptor.
 *
 * Trust boundary (#1310, §10o): this reads `req.secure`, never the raw
 * `X-Forwarded-Proto` header. Express applies that header only for a hop
 * `TRUSTED_PROXY_ADDRESSES` names, which defaults to naming none.
 */
export function requestIsSecure(req: Request): boolean {
  switch (publicSchemeMode(req)) {
    case 'https':
      return true;
    case 'http':
      return false;
    case 'auto':
      return req.secure === true;
  }
}

/** The app's mode, defaulting to `auto` for an app (or a test double) that set none. */
export function publicSchemeMode(req: Pick<Request, 'app'>): PublicSchemeMode {
  const get = req.app?.get as ((name: string) => unknown) | undefined;
  if (typeof get !== 'function') return 'auto';
  const raw = get.call(req.app, PUBLIC_SCHEME_SETTING);
  const mode = typeof raw === 'string' ? raw.trim() : '';
  return isPublicSchemeMode(mode) ? mode : 'auto';
}

/** An IP, or an IP with a prefix length that fits its family. */
function isAddressOrBlock(entry: string): boolean {
  const slash = entry.lastIndexOf('/');
  if (slash === -1) return isIP(entry) !== 0;
  const address = entry.slice(0, slash);
  const bits = entry.slice(slash + 1);
  const family = isIP(address);
  if (family === 0) return false;
  if (!/^\d{1,3}$/.test(bits)) return false;
  const width = Number(bits);
  return width >= 0 && width <= (family === 4 ? 32 : 128);
}
