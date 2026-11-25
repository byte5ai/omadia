# 0161 — The web-ui is the browser's only origin; it proxies the middleware at request time

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main; the login
  gate and its allowlist are documented in `docs/security-architecture.md` §10g, the forwarded
  scheme in §10o / #1310, the canvas socket relay in spec 2042)

## Context and Problem Statement

This record is retroactive: it documents a design that is implemented on main.

omadia ships two server processes, the middleware (Express kernel, `/api/*`, `/p/*`) and the
web-ui (Next.js App Router). A browser needs both: pages from the web-ui, data and plugin UI
bundles from the middleware, and a WebSocket for the canvas. The session is a cookie
(`omadia_session`). Which host does the browser talk to, where is the session checked, and how
does one published web-ui image find its middleware on Compose, Fly, Render and the desktop app?

## Decision Drivers

- One cookie scope and no CORS: the session cookie belongs to the host the person signed in on.
- One image must run anywhere; the middleware address is a runtime fact, not a build fact.
- The middleware's `requireAuth` stays the only authority on a session.
- Streaming (SSE turn events, multi-megabyte plugin ZIP uploads) must pass through untouched.

## Considered Options

- **A — The web-ui is the single browser origin and reverse-proxies the middleware from route
  handlers that read `MIDDLEWARE_URL` per request.**
- **B — `next.config.ts` `rewrites()` to the middleware.**
- **C — The browser calls the middleware host directly (CORS, cross-site cookie).**

## Decision Outcome

Chosen option: **A**.

- **Same-origin API surface.** Browser code calls relative `/bot-api/*`
  (`web-ui/app/_lib/api.ts`); `app/bot-api/[[...path]]/route.ts` and `app/p/[[...path]]/route.ts`
  forward to the middleware's `/api` and `/p` through `createMiddlewareProxy`
  (`app/_lib/middlewareProxy.ts`). Server Components call `MIDDLEWARE_URL` directly instead of
  going through their own Next server.
- **Resolved per request, never at build or module scope.** `MIDDLEWARE_URL` (default
  `http://localhost:3979`) is read inside the handler. `web-ui/Dockerfile` carries no build ARG
  for it and says not to reintroduce one. The same rule applies to response headers: they are
  set per request in `proxy.ts`, not in `next.config.ts` `headers()`, so `UI_FRAME_ANCESTORS`
  works on a prebuilt image.
- **The proxy declares, it does not relay, the scheme.** Hop-by-hop headers and `host` are
  dropped; an inbound `x-forwarded-proto` is discarded and replaced with `publicScheme()`,
  because the middleware derives the auth cookies' `Secure` flag from it. Redirects are passed
  through (`redirect: 'manual'`), `Set-Cookie` values are re-appended one by one.
- **The login gate is decode-only.** `web-ui/proxy.ts` (the Next 16 `proxy.ts` convention)
  redirects to `/login?return=…` unless the cookie holds an unexpired JWT
  (`app/_lib/sessionToken.ts`). It verifies no signature. A stale cookie is deleted.
- **A closed public allowlist.** `/login`, `/setup`, `/bot-api/v1/auth/*`, `/_next/*`,
  `/health`, `/favicon.ico`, the pairing descriptor (`/.well-known/omadia-ui` and its handler
  path, exact match) and `/p/*`. `/p/*` is public here because Teams tabs frame it without an
  omadia cookie; the middleware enforces the session on each plugin route.
- **WebSockets are relayed below Next.** Route handlers cannot upgrade a connection, so the
  image's entry point `scripts/runtime/omadia-server.mjs` takes the upgrade of exactly
  `/omadia-ui/canvas` (`canvasWsProxy.mjs`) and relays it, cookies included. Every other
  upgrade stays Next's.

### Consequences

- 🟢 **Good:** One published image for every platform; `MIDDLEWARE_URL` is an ordinary
  runtime setting.
- 🟢 **Good:** No CORS configuration and no cross-site cookie; the canvas socket carries the
  session cookie because it is on the same host.
- 🔴 **Bad:** Every API call takes a second hop through the Next server, and the proxy code has
  to keep header, cookie and streaming semantics right by hand.
- 🔴 **Bad:** The gate proves only that the browser holds something shaped like a live session.
  A forged cookie renders the page shell and then fails on every API call.
- 🔴 **Bad:** The image no longer starts with Next's stock `server.js`; a second upgrade path
  needs its own relay.
- ⚪ **Neutral:** A surface that must be framed belongs under `/p/*` or `/bot-api/*`, whose
  headers the middleware sets; `app/_lib/securityHeaders.ts` says not to widen that exemption.

## Pros and Cons of the Options

### A — Runtime proxy in route handlers

- 🟢 Runtime configuration, one origin, streaming preserved.
- 🔴 Hand-written proxy; extra hop.

### B — `rewrites()`

- 🟢 No proxy code.
- 🔴 Next evaluates `rewrites()` at build time and freezes the destination into
  `routes-manifest.json`. The published image had the compose hostname baked in and ignored
  `MIDDLEWARE_URL` on every other platform (comment in `web-ui/next.config.ts`). Only the
  static pairing-discovery rewrite remains.

### C — Direct calls to the middleware

- 🟢 No proxy hop.
- 🔴 Two public hosts per install, CORS, and a cookie that does not reach the other host.

## More Information

- Code: `web-ui/proxy.ts`, `web-ui/app/_lib/middlewareProxy.ts`, `web-ui/app/_lib/publicScheme.ts`,
  `web-ui/app/_lib/securityHeaders.ts`, `web-ui/scripts/runtime/canvasWsProxy.mjs`,
  `web-ui/next.config.ts`.
- Tests: `web-ui/app/__tests__/proxy.test.ts`.
- Docs: `docs/security-architecture.md` §10e, §10g, §10h, §10o.
- Related drafts: [ADR-0160](0160-web-ui-loading-boundaries-and-true-404-status.md),
  [ADR-0066](0066-plugin-ui-runs-in-a-same-origin-frame-with-a-fixed-style-vocabulary.md),
  [ADR-0148](0148-build-stamp-is-the-version-of-record-and-health-reports-it.md).
