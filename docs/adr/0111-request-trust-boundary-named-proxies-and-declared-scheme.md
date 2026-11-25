# 0111 — The request trust boundary: forwarded headers count only from named hops; the scheme can be declared

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main);
  implemented for #1310 in PR #1356.

## Context and Problem Statement

This record is retroactive: it documents a decision that is implemented on main.

`X-Forwarded-Proto`, `X-Forwarded-For` and `X-Forwarded-Host` are ordinary request headers.
The app ran with `trust proxy = true`, and the helper that sets the `Secure` flag on the
session cookie, the login-device cookie and the OIDC PKCE cookie read the raw
`X-Forwarded-Proto` header. The sender of a request therefore decided whether its own auth
cookies were TLS-only. That breaks two deployments in opposite directions: a TLS proxy that
sets no header yields cookies without `Secure`, and a forged header in front of plain HTTP
yields `Secure` cookies the browser discards, so login silently does nothing. Who may speak
for the client, and how does the kernel learn the public scheme?

## Decision Drivers

- A value the client can write must not decide a security attribute.
- The default must be safe with no configuration.
- Platforms whose edge addresses are not stable (Fly, Render) must still get `Secure` cookies.
- Every scheme-shaped decision (cookies, `wss://` canvas URL, login base) must agree.

## Considered Options

- **A — Trust only named proxy addresses (default: none); read `req.secure`; let the
  operator declare the public scheme.**
- **B — Keep reading the header, set `trust proxy` to the number of proxies.**
- **C — Keep `trust proxy = true`.**
- **D — A cookie-only "always Secure" flag.**

## Decision Outcome

Chosen option: **A** (`http/requestTrust.ts`).

- **`TRUSTED_PROXY_ADDRESSES`** is the Express `trust proxy` value: a comma-separated list
  of addresses, `IP/bits` blocks or the aliases `loopback` / `linklocal` / `uniquelocal`, at
  most 16 entries. Empty is the default: trust no hop. A bare number and any `/0` block are
  refused at boot, each with its reason.
- **`requestIsSecure` reads `req.secure`**, never a header. All three cookie writers call it.
- **`PUBLIC_SCHEME`** (`auto` | `https` | `http`, default `auto`) is the operator's statement
  for a TLS proxy that cannot be named or sets no header. It is stored as an Express app
  setting (`omadia:public-scheme`) and governs the cookies and the pairing descriptor's
  `wss://`/`https://` URLs alike. A stale `always`/`never` value fails the boot.
- **The web-ui proxy states the scheme itself.** `/bot-api/*` and the canvas WebSocket relay
  drop the browser's `X-Forwarded-Proto` and set it from `WEB_UI_PUBLIC_SCHEME` (`http`
  default, or `https`). There is no relay mode: a trusted hop that relays a forged header
  launders it.
- **Gates that must not depend on it do not.** The sign-in limiter has its own
  `AUTH_LOGIN_CLIENT_ADDRESS` policy; the dev-endpoint loopback guard reads the socket peer.
  Security decisions do not read `req.ip`, `req.ips` or `req.protocol`.

### Consequences

- 🟢 **Good:** A forged `X-Forwarded-Proto` no longer changes a cookie attribute.
- 🟢 **Good:** An unconfigured install believes nothing forwarded.
- 🔴 **Bad:** `PUBLIC_SCHEME=https` and `WEB_UI_PUBLIC_SCHEME=https` are assertions the code
  cannot check. Set on a deployment reachable over plain HTTP, every login silently fails.
  An HTTPS deployment has to set both.
- 🔴 **Bad:** A `loopback` / `linklocal` / `uniquelocal` entry trusts everything inside that
  range, the real proxy included.
- 🔴 **Bad:** No shipped topology names a proxy address (Fly and Render declare `https`), so
  `TRUSTED_PROXY_ADDRESSES` is exercised only by operator-run proxies.
- 🔴 **Bad:** `X-Forwarded-Host` stays client-settable on the pairing path, bounded by
  `OMADIA_UI_PUBLIC_WS_URL`.
- ⚪ **Neutral:** One non-security use of `req.ip` remains as the fallback key of the
  Conductor people-search limiter (`conductor/routes.ts`), behind the session gate.

## Pros and Cons of the Options

### A — Named hops, `req.secure`, declared scheme

- 🟢 Only an address the client does not have refuses the forgery; this option names one.
- 🔴 Two settings per HTTPS deployment, both unverifiable by the code.

### B — Hop count

- 🟢 Familiar Express advice.
- 🔴 Express counts trusted hops including the immediate peer: a client that connects
  directly is trusted hop #1. Measured: `trust proxy = 1`, `2` and `'loopback'` all believed
  a forged header from a direct loopback client.

### C — Trust every hop

- 🟢 Works behind any proxy without configuration.
- 🔴 The reported defect.

### D — Cookie-only flag

- 🟢 Smallest change.
- 🔴 A connection-only answer would still advertise `ws://` to an HTTPS page, which the
  browser blocks as mixed content.

## More Information

- Code: `middleware/src/http/requestTrust.ts`, `middleware/src/auth/sessionCookie.ts`,
  `auth/loginDeviceCookie.ts`, `auth/clientAddress.ts`, `auth/loopbackOnly.ts`,
  `web-ui/app/_lib/middlewareProxy.ts`.
- Tests: `middleware/test/http/cookieSecure.test.ts` (a real listener over plain HTTP),
  `middleware/test/http/requestTrust.test.ts`, `middleware/test/auth/clientAddress.test.ts`.
- Docs: `docs/security-architecture.md` §10o.
- Related: [ADR-0106](0106-operator-sessions-stateless-jwt-with-server-side-revocation.md),
  [ADR-0109](0109-password-sign-in-rate-limiting-pairs-and-device-cookie.md).
- Border: web-ui (proxy and pairing descriptor).
