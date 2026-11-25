# 0104 — Every unanswered request ends in a JSON `{ code, message }`; a terminal callback replaces Express's final handler

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main);
  implemented in PR #1410 for #1326, #1318 and #1349.

## Context and Problem Statement

This record is retroactive: it documents a decision that is implemented on main.

Express's built-in `finalhandler` answers whatever no router handled with an HTML page and,
unless `NODE_ENV` is `production`, writes the error's stack trace into it. The Compose
stack runs with `NODE_ENV=development`, so a truncated JSON body sent anonymously to the
public API came back as HTML listing container paths (#1326), a non-UUID admin id did the
same (#1318), and an unknown path got `<pre>Cannot GET …</pre>` (#1349). The usual fix, an
error middleware and a catch-all at the end of the stack, does not work here: plugins mount
routers after boot. What answers a request nobody answered, and in which shape?

## Decision Drivers

- No stack trace or filesystem path in a response, whatever `NODE_ENV` is.
- API clients parse JSON; an HTML error page is a second, undocumented format.
- A route mounted after boot (plugin install, re-activation) must be reachable at once.
- A malformed id must not reach Postgres and come back as a 500 with the database message.
- Client mistakes should not fill the log with stack traces.

## Considered Options

- **A — A terminal callback passed to the app function, answering JSON `{ code, message }`.**
- **B — A catch-all `app.use` and an error middleware registered at the end of boot.**
- **C — Set `NODE_ENV=production` everywhere** and keep `finalhandler`.

## Decision Outcome

Chosen option: **A** (`http/terminalHandler.ts`).

- **Last by construction.** `createAppServer` builds the `http.Server` itself and calls
  `app(req, res, done)`; `done` runs only after the whole router stack, including anything
  mounted later, has declined. `app.listen` is not used, because it installs `finalhandler`.
- **One shape.** The terminal handler always answers `{ code, message }` with
  `Content-Type: application/json` and `X-Content-Type-Options: nosniff`. `code` is a stable
  dotted identifier, `message` human-readable and never a stack.
- **Mapping.** body-parser errors map by type (`entity.parse.failed` →
  `400 request.invalid_json`, `entity.too.large` → `413 request.payload_too_large`, and six
  more); another 4xx error keeps its status and is named by it (`unauthorized`, `forbidden`,
  `not_found`, `method_not_allowed`, …) or `request.invalid`; no router → `404 not_found`;
  a path under a declared but ungranted plugin public prefix → `404
  public_path.not_granted`; anything else → `500 internal` with the detail in the log only.
- **Logging.** A client error is one `warn` line; a server error is logged with the error.
  When headers were already sent the socket is destroyed, as `finalhandler` does.
- **The same shape upstream.** The session gate (`auth.*`), the Teams SSO gate, the uuid
  guard and the Conductor routes answer `{ code, message }` too, so a client can branch on
  `code` whoever refused it.
- **Ids are checked before the store.** A route whose `:id` is a Postgres `uuid` column
  registers `router.param(name, requireUuidParam('<area>.not_found'))` (`http/uuidParam.ts`).
  The default refusal for a malformed id is `404`; ADR-0038 records the `400` variant
  Conductor chose.
- **Flags in request text** are read through `isTruthyFlag` (`http/requestFlags.ts`): only
  `1`, `true`, `yes` switch a flag on; anything else, an empty or repeated value included,
  is false, so a destructive confirmation is never implied.

### Consequences

- 🟢 **Good:** No stack or container path leaves the server on any `NODE_ENV`.
- 🟢 **Good:** Plugin routes mounted at runtime work without a restart.
- 🔴 **Bad:** The envelope is not uniform across the API. On main roughly 400 response sites
  in `middleware/src` send `{ code, … }` and roughly 290 send the older `{ error: … }`
  (for example `routes/agentBuilder.ts`, `routes/operatorAgents.ts`); some carry both keys.
  New routes use `{ code, message }`; the old ones were not migrated.
- 🔴 **Bad:** The terminal callback relies on Express forwarding a third `done` argument,
  which its published types do not declare.
- 🔴 **Bad:** The global JSON parser still reads up to its 10 MB limit before any route or
  authentication runs; `http/rawBodySize.ts` only lets a route measure the real wire size.
- ⚪ **Neutral:** Two id conventions coexist (404 and 400 for a malformed id), see ADR-0038.

## Pros and Cons of the Options

### A — Terminal callback

- 🟢 Cannot be shadowed by a later mount; one place for the last answer.
- 🔴 Depends on undocumented-in-types Express behaviour.

### B — Catch-all at the end of boot

- 🟢 The textbook Express pattern.
- 🔴 `PluginRouteRegistry` mounts routers with `app.use` after boot; they would land behind
  the catch-all and answer 404 until the next restart.

### C — `NODE_ENV=production`

- 🟢 No code.
- 🔴 Still HTML; and the Compose stack sets `development` on purpose so it can boot on a
  dev vault key.

## More Information

- Code: `middleware/src/http/{terminalHandler,uuidParam,requestFlags,rawBodySize}.ts`,
  `middleware/src/index.ts` (`createAppServer`).
- Tests: `middleware/test/terminalHandler.test.ts`, `test/conductorRouteIdGuards.test.ts`,
  `test/auth/adminUsersRoute.test.ts`.
- Docs: `docs/middleware-agent-handoff.md` (terminal handler rules, uuid-guard rule).
- Related: ADR-0038, [ADR-0105](0105-one-api-session-gate-and-a-closed-public-path-list.md),
  [ADR-0112](0112-secret-vault-and-credential-keychain-two-master-keys.md).
