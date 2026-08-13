/**
 * Issue #669 — an optional address gate for the `/api/dev/*` scaffolding.
 *
 * The primary fix for #669 is that `/api/dev/*` now sits behind the same
 * session gate as every other `/api` route. This is the second half of the
 * issue's suggested direction: an operator who considers that surface
 * genuinely local-only can bind it to loopback instead of relying on a code
 * comment saying "LOCAL USE ONLY".
 *
 * Opt-in (`DEV_ENDPOINTS_LOOPBACK_ONLY=true`), NOT the default: in a
 * containerised dev setup the browser talks to the Next.js server, which
 * proxies `/bot-api/*` to the middleware from a container address. Defaulting
 * this on would break that flow, and the session gate already closes the hole.
 *
 * Trust boundary: this reads the SOCKET address (`req.socket.remoteAddress`),
 * never `X-Forwarded-For`. Express's `trust proxy` makes `req.ip` reflect
 * client-supplied headers, so gating on `req.ip` would let a caller claim
 * `127.0.0.1` and walk straight through. A guard that a header can defeat is
 * decoration.
 */

import type { RequestHandler } from 'express';

/**
 * Loopback literals, including the IPv4-mapped IPv6 form Node reports when a
 * v4 client reaches a dual-stack listener (`::ffff:127.0.0.1`). The whole
 * `127.0.0.0/8` block counts — `127.0.0.2` is as local as `127.0.0.1`.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const addr = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  if (addr === '::1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (!v4) return false;
  const octets = v4.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return false;
  return octets[0] === 127;
}

/**
 * Refuse anything that did not arrive over a loopback socket with `403`.
 *
 * Returns a pass-through when `enabled` is false, so the call site stays one
 * unconditional line and the disabled state is exercised by the same code path.
 */
export function createLoopbackOnly(opts: {
  enabled: boolean;
  log?: (message: string) => void;
}): RequestHandler {
  if (!opts.enabled) {
    return (_req, _res, next) => {
      next();
    };
  }
  const log = opts.log ?? ((m: string) => console.warn(m));
  return (req, res, next) => {
    const remote = req.socket.remoteAddress;
    if (isLoopbackAddress(remote)) {
      next();
      return;
    }
    log(
      `[middleware] /api/dev refused non-loopback request from ${remote ?? 'unknown'} (DEV_ENDPOINTS_LOOPBACK_ONLY=true)`,
    );
    res.status(403).json({
      code: 'dev.loopback_only',
      message: 'dev endpoints are bound to loopback on this deployment',
    });
  };
}
