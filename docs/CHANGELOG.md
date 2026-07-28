# Changelog

All notable changes to omadia are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The canonical, always-current changelog per version is each release's GitHub
Release notes — generated automatically by `.github/workflows/auto-release.yml`
from Conventional Commit messages, no release ships without one. This file is
a periodically-refreshed mirror of the same data (every section from
`[0.2.1]` onward via `.github/scripts/generate-changelog.mjs backfill`), not
auto-committed on every release. Add hand-written notes under
`## [Unreleased]` any time; they carry over verbatim into the next version's
entry. See `CONTRIBUTING.md` § Releases & changelog.

---

## [Unreleased]

### Added — API keys as a first-class authentication method, with per-key scopes (#439)

- New workspace package `@omadia/api-key-auth`
  (`middleware/packages/harness-api-key-auth/`). The API-key primitives
  #438 shipped inside `@omadia/channel-api` — mint/sha256-hash/constant-time
  verify, the vault-backed key store, the per-key rate limiter, the usage
  audit log — moved here unchanged, so there is exactly **one**
  implementation of the credential. A shared workspace package is the only
  home both sides can reach: the kernel must never import a channel plugin,
  and a plugin cannot import kernel source (`middleware/src/auth/` is not
  resolvable from a package whose `tsconfig` has `rootDir: src`). Same role
  `@omadia/plugin-api` and `@omadia/channel-sdk` already play. The package is
  dependency-free apart from an `express` peer — its storage dependency is a
  structural subset (`ApiKeySecretStorage`) that `SecretsAccessor` satisfies
  without an adapter. No new npm dependencies, matching #438.
- New mountable Express middleware `requireApiKey({ apiKeys, rateLimiter,
  auditLog, scope })`: any route or plugin can apply it and be authenticated
  by a server-to-server bearer key instead of the `omadia_session` cookie
  (driving use case: a Laravel/PHP integration with no human session behind
  it). It attaches an `ApiKeyPrincipal` to `req.apiKey` and deliberately does
  **not** populate `req.session` — `SessionClaims.role` is hard-typed
  `'admin'`, so synthesizing a session for a machine would make every
  session-reading route downstream silently treat a key as an operator.
  401/403/429 use the `{ error, message }` shape #438 established for the
  public API surface, not the session gate's `{ code, message }`, so the wire
  format of `POST /api/public/v1/chat` is unchanged.
- Per-key **scopes**: `<resource>:<action>` strings (or the global `*`),
  matched exactly — no prefix wildcards, which are how "I thought `admin:*`
  didn't cover `admin:delete`" happens. A route declares the scope it needs;
  a key without it gets `403 forbidden` and a `forbidden` audit entry.
  Backward compatible: a key persisted before scopes existed carries no
  `scopes` field and is normalized to `['chat:write']` — exactly the one
  capability it had when it was minted. Defaulting such keys to `*` would
  also keep them working and would silently widen every existing key to
  whatever scoped surface lands next, so it is not what we do.
  `POST /api/public/v1/admin/keys` accepts a `scopes` array (validated, 400
  on a malformed scope) and `GET` lists it.
- `normalizeScopes` distinguishes an **absent** `scopes` field from a
  **malformed** one, because collapsing the two turns a read error into a
  capability grant. Absent (`undefined`) → the legacy `['chat:write']`.
  Present but unreadable — not an array (`"memory:read"` stored as a bare
  string), an empty array, or an array with any invalid entry
  (`['Chat:Write']`, `['chat:write','nonsense']`) → the **empty** scope set:
  the key still authenticates, and every scope check on it fails closed with
  `403`. A malformed record is at least as likely to be a key an operator
  deliberately restricted *away* from chat as it is to be a lost pre-#439
  key, and defaulting it to `chat:write` would hand back exactly the access
  that was removed. Partially-valid arrays deny rather than silently narrow.
  Every such case logs `[api-key-auth] malformed persisted scopes` so an
  operator can tell a corrupt record from a revoked key. The scope set is
  always persisted explicitly at `create()` time, so nothing this store
  writes can be mistaken for a pre-#439 record.
- `@omadia/channel-api` now consumes the shared package instead of owning
  the code: `chatRouter.ts` mounts `requireApiKey` with `scope: 'chat:write'`
  rather than parsing bearer headers itself. Behaviour and wire format of
  `POST /api/public/v1/chat` are unchanged, and its existing test suite
  passes as written (only the moved modules' import paths were repointed).
- `middleware/src/auth/publicPaths.ts` is deliberately **not** broadened —
  `/api/public/v1/chat` is still the only exempted API-key route. Its comment
  now records what a future route that mounts `requireApiKey` has to do.
- The `scopes` additions to `/api/public/v1/admin/keys` sit **on top of** the
  kernel-level `ctx.operatorAuth` session gate that the entry below adds to
  that router, not beside it: an anonymous `POST` carrying `scopes: ['*']`
  is rejected `401` before any handler runs, covered by its own regression
  test in `adminKeysRouter.test.ts`.
- Tests: `test/auth/requireApiKey.test.ts`, `test/auth/apiKeyScopes.test.ts`,
  and `test/channelApi/apiKeyAuthReuseSeam.test.ts` — the last one is a
  structural guard on the seam itself (the plugin holds no second copy of the
  primitives, and `middleware/src` imports no channel plugin), because
  "where does this code live" is a property no runtime assertion can express
  and the cheapest one to regress.

### Added — public API channel: chat over HTTP with per-key auth (#438)

- New built-in channel package `@omadia/channel-api`
  (`middleware/packages/harness-channel-api/`) exposes `POST
  /api/public/v1/chat` — a documented, self-authenticating HTTP entry point
  external systems can drive without a channel adapter or the operator UI.
  Streams the SAME NDJSON event framing as `/chat/stream` and dispatches
  through `CoreApi.handleTurnStream`, so PII masking (privacy-guard), memory,
  and the knowledge graph all apply exactly as they do for every other
  channel — no second response-masking path.
- Credential model (locked design decision on the issue): each API key **is**
  its own identity — `ChannelUserRef{ channel: 'api', id: 'key:<id>' }` —
  not a delegate for a human end-user. No impersonation surface.
- Full v1 security posture, not deferred: API keys are vault-backed (this
  plugin's own `ctx.secrets` namespace, no DB migration) and verified with
  `crypto.timingSafeEqual` against a sha256 hash — the plaintext is shown
  exactly once, at creation; per-key configurable rate limits (fixed-window,
  429 on overage); an explicit revoke endpoint (`POST
  /api/public/v1/admin/keys/:id/revoke`) that fails the next request
  immediately; and a usage audit log (who/what/when) recorded on every
  authenticated call.
- Key lifecycle (`GET`/`POST /api/public/v1/admin/keys`, revoke) is
  deliberately mounted under the SAME `/api/public/v1` prefix but NOT added
  to `middleware/src/auth/publicPaths.ts`'s exemption list — only `.../chat`
  is public. Key management stays behind the normal operator session, like
  every other admin surface in this app — see the security-fixup entry below
  for how that's actually enforced (an earlier note here claimed the
  publicPaths omission alone was sufficient; it wasn't).
- Review fixups: the internal `conversationId` handed to `CoreApi` is now
  namespaced by key id (`${key.id}:${callerConversationId}`) so two
  different API keys can never collide on the same core-side scope, even
  when they send an identical caller-supplied `conversationId` — closes a
  cross-key transcript/context leak. The usage audit log now records one
  entry for every authenticated call (not just the success path) with a
  status reflecting the real outcome — `ok` | `rate_limited` |
  `invalid_request` | `error` — instead of writing `status: 'ok'`
  optimistically before dispatch.
- Second review fixup round: the audit-status fix above still had a gap —
  `deps.core.handleTurnStream` can yield an in-band `{type:'error',
  message}` event on the already-open stream WITHOUT throwing (same bug
  class as #403), and the loop completing normally was still recorded as
  `ok`. `chatRouter.ts` now tracks whether an `error`-type event was
  forwarded during iteration and audits `error` in that case too, with a
  regression test covering the no-throw path. Docs: the README's event
  table no longer claims `agent_bound` is emitted on this route (it isn't —
  that event is synthesized by the kernel's own `/api/chat/stream` handler,
  not by `CoreApi.handleTurnStream`) and now documents the verifier-mode
  `{type:'verifier'}` event that can follow `done`. `docs/security-architecture.md`
  § 8 and the README's rate-limiting section now say explicitly that the
  limiter is in-memory and per-process, not shared across replicas
  (accepted v1 trade-off, no code change). `harness-channel-api`'s
  `peerDependencies` on `@omadia/channel-sdk` / `@omadia/plugin-api` are now
  pinned to `^0.1.0` instead of `"*"`, per `CONTRIBUTING.md`'s dependency
  hardening policy.
- Security fixup: `/api/public/v1/admin/keys` was, in fact, completely
  unauthenticated — mounting via `core.registerRouter` applies only an
  active/inactive gate, never `requireAuth`, and NOT being in
  `publicPaths.ts` does nothing to change that (any anonymous caller could
  mint, list, or revoke API keys). Fixed at the kernel level, not just in
  this plugin: `PluginContext` gains an optional `ctx.operatorAuth`
  (`OperatorAuthAccessor`, `packages/plugin-api/src/pluginContext.ts`),
  published by the kernel and threaded into every plugin runtime
  (`ToolPluginRuntime`, `DynamicAgentRuntime`, `DefaultChannelRegistry`) so
  any future plugin needing an operator-only admin surface can reuse it.
  `hasValidSession(cookieHeader)` reuses the EXACT SAME session-verification
  logic `requireAuth` runs (extracted to `evaluateSessionToken` in
  `src/auth/requireAuth.ts`) — one code path, not two that can drift apart.
  `adminKeysRouter.ts` now applies it as router-level middleware ahead of
  every route: missing/invalid session → `401`; `ctx.operatorAuth` itself
  unavailable → `503` (fail closed, never silently unauthenticated). New
  end-to-end coverage in `adminKeysRouter.test.ts` mounts the router behind
  the REAL accessor (not a stub) and asserts the no-cookie / invalid-cookie
  / valid-cookie and fail-closed paths. `docs/security-architecture.md` § 8,
  this package's `README.md`, and `docs/middleware-agent-handoff.md` are
  corrected to describe the real mechanism.

### Fixed — orchestrator no longer offers or invokes a not-yet-authenticated plugin's tools (#474)

- A native plugin (`ctx.tools.register` from `activate()`) whose own
  connection/auth setup is still pending — reported via the existing
  `ctx.status.report({state: 'needs_action' | 'error'})` — is now excluded
  from the tool list the orchestrator offers the model
  (`Orchestrator.buildToolsList`), instead of being offered and failing on
  the first call. The same check runs again at invocation time
  (`Orchestrator.dispatchToolInner` and the standalone
  `ToolDispatchService` used by the subscription-CLI provider), so a status
  change between list-assembly and the actual call can't slip through
  either. Plugins that never report a status (the common case — no
  connection step) are unaffected. Deliberately separate from the
  MCP-server-specific auth-gap flow (`mcpOAuthService`), which already
  handles that case for MCP servers.
- Follow-up (review round 2): `Orchestrator.getSystemPrompt()` now applies
  the same `isToolAvailable` gate to the plugin `promptDoc` collection that
  `buildToolsList()` already applied to the tool specs — a gated plugin's
  documentation is no longer spliced into the system prompt while its tool
  is simultaneously hidden from `tools[]`. Previously the model would still
  be told about a capability whose spec had just been removed, replacing a
  clean "tool not offered" state with a confusing "documented but missing
  tool" one.
- Follow-up (review round 3): the gate only covered native tools registered
  via `ctx.tools.register()` — `Orchestrator.buildToolsList()` still
  appended every `DomainTool` (the dynamic-agent-plugin tools, e.g.
  `query_<slug>`) unconditionally, and `dispatchToolInner()` still invoked
  a matching one without any readiness check. Both call sites now apply
  the same `isToolAvailable(agentId)` gate `DomainTool.agentId` already
  carries, so a not-ready plugin's domain tool is excluded from `tools[]`
  and refused (`Error:`-prefixed, handler never invoked) at dispatch time,
  matching the native-tool path exactly.
- Follow-up (review round 4): two remaining gaps of the same kind. First,
  `Orchestrator.buildSystemPrompt()`'s "Fach-Agenten" roster block — the
  human-readable list of domain tools rendered ahead of the tool specs —
  still listed every `DomainTool` unconditionally, so a not-ready plugin's
  tool was hidden from `tools[]` but the model was still told to route to it
  by name. `Orchestrator.getSystemPrompt()` now filters the roster through
  the same `isToolAvailable(agentId)` gate before it reaches
  `buildSystemPrompt()`. Second, `PluginStatusRegistry.isReady()` only
  returned `true` when there was no stored status entry at all — correctness
  depended entirely on every caller normalizing `state: 'ok'` into `clear()`
  before it reached the registry's own `set()`, which only the higher-level
  `StatusAccessor.report()` in `pluginContext.ts` did. `isReady()` now
  checks the stored entry's `state` directly (`!entry ||
  (entry.state !== 'needs_action' && entry.state !== 'error')`), so it stays
  correct even for a caller that stores `{state: 'ok'}` via `set()` directly.
  Also closed during the same audit: `Orchestrator.directLineObligationState()`
  (the `#332` forced-delegation primitive) could still resolve a not-ready
  plugin's domain tool as the turn's forced `tool_choice`, which would name a
  tool `buildToolsList()` had already excluded from `tools[]` — now gated the
  same way.
- Follow-up (review round 4/final): the last unguarded consumer of
  `domainToolsByName` — the DirectLine (`#token`) candidate resolution in
  `Orchestrator.executeDirectLine()` — still let a not-ready plugin's
  `#token` resolve successfully. `dispatchToolInner()` already refused the
  handler safely, but its raw `Error: tool … is unavailable …` string was
  then wrapped into a `delegatedAnswer` and shown to the user as though the
  specialist itself had answered. The resolved candidate's readiness is now
  checked against the same `isToolAvailable(agentId)` gate right after
  resolution, reusing the existing "Specialist … is no longer available."
  notice already used for a deleted tool, instead of surfacing the internal
  dispatch-error string.
- Follow-up (review round 5): every gate above depended on the plugin's own
  code calling `ctx.status.report(...)`. The generic install/Connect flow
  never does this automatically — `installService.ts` activates a
  `type:'oauth'` plugin (registering its tools) the moment `configure()`
  completes, which is BEFORE the operator has clicked "Connect" and the
  kernel OAuth broker has stored any tokens. A plugin author who never wrote
  an explicit status-report call for this (the common case) still had its
  tools offered and invoked, failing with `OAuthTokenError('not_connected')`
  on the first call — the exact round-trip #474 was filed to eliminate. A
  new `OAuthReadinessTracker` derives connection state from the same vault
  state `ctx.oauthTokens` reads, refreshed on every `ToolPluginRuntime` /
  `DynamicAgentRuntime` `activate()` (fresh install, boot reactivation, and
  post-Connect reactivation all funnel through this single choke point per
  runtime). The orchestrator's readiness gate now ANDs this automatic signal
  with the existing `PluginStatusRegistry` one — either can withhold
  readiness — kept as two separate caches rather than one merged into the
  other, so neither can silently clobber the other's verdict.
- Follow-up (review round 8): every gate above only covered
  `ctx.tools.register()` — `NativeToolRegistry.registerHandler()` (used by
  `ctx.tools.registerHandler()` for tools whose wire-spec the kernel emits
  itself, e.g. the Anthropic-native `memory` tool used today by
  `harness-memory` / `harness-memory-postgres`) never stored an `agentId` on
  its entry at all, so `isToolAvailable`'s `agentId === undefined ⇒
  always-available` default — correct for a genuinely kernel-internal
  registration — incorrectly also applied to ANY plugin using this path
  instead of `register()`, leaving its `promptDoc` in the system prompt and
  its handler dispatchable regardless of the plugin's own readiness.
  `NativeToolHandlerRegistrationOptions` and the stored
  `NativeToolRegistration` entry both gained the same optional `agentId` the
  `register()` path already carries, and `ctx.tools.registerHandler()` in
  `pluginContext.ts` now passes the calling plugin's own id, mirroring
  `ctx.tools.register()`'s existing wiring exactly — no new gate logic, the
  entry just flows through the same `isToolAvailable(agentId)` check every
  other path already uses. The two current `registerHandler()` callers
  (`harness-memory`, `harness-memory-postgres`) are unaffected in practice:
  neither reports a connection status, so `PluginStatusRegistry.isReady()`
  defaults them to ready, exactly as before this fix.
- Follow-up (review round 10), two remaining gaps: (1)
  `OAuthReadinessTracker.refresh()` treated `tokens !== undefined` alone as
  "connected" — it only checked that SOME token bundle was stored in the
  vault, not that it was actually usable. `ctx.oauthTokens.get()`
  (`pluginContext.ts`) throws `OAuthTokenError('refresh_failed')` for a
  token that's expired AND has no refresh token to renew it with, so a
  plugin in that state was still reported ready, offered, and dispatched —
  failing on the first real call with the exact wasted round-trip #474 was
  filed to eliminate. The "still fresh" expiry check `ctx.oauthTokens.get()`
  already computes is now factored out into `tokenStore.ts`'s
  `isTokenStillFresh`/`isTokenRefreshable` and reused by both call sites, so
  the two can never drift on what counts as expired; a token that's expired
  but HAS a refresh token still counts as ready (a refresh is expected to
  succeed transparently). (2) The built-in Anthropic `memory` tool
  (`{type:'memory_20250818', name:'memory'}`) is special-cased in both
  `buildToolsList()` and `dispatchToolInner()` and dispatched via the
  orchestrator's own per-Agent-scoped `memoryToolHandler` BEFORE the general
  `NativeToolRegistry`/`isToolAvailable(agentId)` gate is ever consulted —
  so a plugin contributing `memory` via `ctx.tools.registerHandler('memory',
  ...)` (the same path `harness-memory`/`harness-memory-postgres` use) with
  `isPluginToolsReady(pluginId) === false` still had it offered and
  dispatched, completely bypassing round 8's fix. Both call sites now look
  up the `memory` entry's own `agentId` (if any plugin registered it) and
  run it through the same `isToolAvailable` gate before taking the fast
  path. A marker-only / agentId-less entry (nothing registered `memory` via
  a plugin) keeps the existing "no agentId ⇒ always-available" default, so
  the two current always-ready memory plugins are unaffected as long as they
  haven't reported not-ready — covered by a new test alongside the
  gated-plugin case.
- Follow-up (review round 12): `OAuthReadinessTracker.isConnected()` read a
  boolean cached once inside `refresh()` — activation time — instead of
  re-checking freshness against the current wall clock. A plugin activating
  with, say, 10 minutes of token freshness left and no refresh token cached
  as "ready" and stayed that way until the NEXT activation, even after
  crossing `tokenStore.ts`'s 5-minute `OAUTH_REFRESH_MARGIN_MS`, where a real
  `ctx.oauthTokens.get()` call would already throw
  `OAuthTokenError('refresh_failed')` — reproducing the exact wasted
  round-trip #474 exists to prevent, just shifted into the gap between
  activations instead of at activation time. `refresh()` now caches only the
  raw per-field `StoredOAuthTokens` (the genuinely async vault read), and
  `isConnected()` recomputes `isTokenRefreshable()`/`isTokenStillFresh()`
  fresh on every call against `Date.now()` — both are pure, synchronous,
  in-memory checks, so recomputing per read has no latency cost. Mirrors how
  `ctx.oauthTokens.get()` itself never caches a verdict either. Covered by a
  new test using `t.mock.timers` to advance the clock past the refresh
  margin without a new `refresh()` call.

### Fixed — streamed turns no longer report a bare error after a tool already committed (#506)

- Root-cause fix for issue #506's actual one-click repro (the earlier
  reconciliation work below only helped on a *retry*). `chatStreamInner`
  in `middleware/packages/harness-orchestrator/src/orchestrator.ts` wraps
  its whole per-turn iteration loop — tool dispatch and every subsequent
  `streamMessageEvents` call — in a single `try`/`catch`. Any exception
  caught there unconditionally yielded a bare `{ type: 'error' }` event,
  even when it happened in a LATER iteration (e.g. the model call that
  generates the natural-language confirmation), after an EARLIER
  iteration's tool call had already committed its side effect and already
  yielded a successful `tool_result`. A user who clicked a create action
  exactly once would have it created server-side and still see a generic
  "Etwas ist schief gegangen" with zero diagnostic value — the false
  negative the issue was filed against. The streaming iteration loop now
  tracks, generically and tool-agnostically (by name only, no per-tool
  special-casing), whether at least one `tool_result` succeeded
  (`isError` falsy) this turn. When the catch block is reached with at
  least one such committed result recorded, it now yields a `done` event
  instead — `ChatStreamEvent`'s existing normal-completion shape,
  already rendered correctly by every channel adapter — with an honest
  answer naming the tool(s) that completed and stating that the turn
  itself could not finish generating a follow-up response. It does not
  claim the whole turn succeeded, and it does not fabricate tool-specific
  detail it doesn't generically have. The underlying error is still
  `console.error`-logged exactly as before for server-side diagnostics;
  only the event yielded to the caller changes. A turn where nothing
  committed yet (the genuine-failure case — e.g. the very first model
  call fails, or the tool call itself errored) still yields `{ type:
  'error' }` unchanged. Together with the reconciliation fix below, this
  closes #506 for both the one-click repro and the retry-duplication
  case; the correlation-id/error-token secondary ask remains explicitly
  out of scope (see below).
- Review follow-up: the emergency `done` yielded from the catch block above
  did not call `this.sessionLogger.log(...)` first — the ONE thing every
  other `done`-emission site in `chatStreamInner` does before yielding (see
  `SessionLogger`'s doc comment: the transcript is what lets a follow-up
  turn recall prior discussion, and what survives a mid-turn crash). For a
  tool whose side effect isn't idempotently reconciled the way routine-create
  now is (e.g. `send_email`, `book_meeting`), an unlogged commit meant the
  *next* turn had no record it happened and could re-invoke the same tool —
  the exact duplicate-side-effect class of bug this fix exists to prevent,
  reintroduced by the fix's own new code path. The emergency-`done` path now
  calls `sessionLogger.log(...)` with the same argument shape as the other
  sites (`scope`, `userMessage`, `assistantAnswer`, `toolCalls`,
  `iterations`, `entityRefs`, optional `userId`/`runTrace`), best-effort
  (a logging failure is caught and logged, never swallows the `done`), and
  surfaces `turnId`/`runTrace` on the yielded event when persistence
  succeeded. `committedToolReporting.test.ts` now constructs the test
  orchestrator WITH a recording `sessionLogger` (the prior 2 tests built one
  without any logger at all, which is why the gap was invisible) and asserts
  the log call happened, with matching `scope`/`userMessage`/
  `assistantAnswer`/`toolCalls`/`iterations`, plus that a genuine failure
  (nothing committed) still does not log.
- Review follow-up: the fix above tracks `committedToolNames` generically —
  ANY successful `tool_result` this turn counts as "committed," with no
  distinction between a read-only tool and a mutating one. A reviewer raised
  the concrete scenario where a read-only tool (e.g. `list_routines`)
  succeeds and a LATER, more consequential tool call then never runs because
  of a transient failure in the model call that would have requested it —
  the turn still reports `done`. This tradeoff — generic-across-all-tools
  vs. narrowed-to-routine-create-only vs. dropping the orchestrator fix
  entirely — was weighed and resolved in favor of keeping the current
  generic, tool-agnostic behavior across all tools, accepting the residual
  risk described above in exchange for fixing the false-negative-on-success
  bug for every side-effecting tool, not just routine creation. This is now
  documented as a deliberate decision (not an oversight) directly in the
  code, on both `committedToolNames`'s
  declaration and the catch block's done-vs-error branch in
  `orchestrator.ts`, and pinned by a new `committedToolReporting.test.ts`
  case (`reports done even when a later intended action never ran (accepted
  tradeoff, see code comment)`) that exercises exactly this multi-tool
  scenario. No production logic changed in this round.

### Fixed — routine create no longer reports failure for a retry that already succeeded (#506)

- `RoutineRunner.createRoutine` previously let a retried `create` (e.g. after
  the turn's own confirmation never made it back over the channel) fall
  through to `RoutineNameConflictError` — a message with no diagnostic value
  that nudged the caller toward trying again under a different name and
  actually duplicating the routine. It now reconciles: on a name conflict it
  looks up the existing row (`RoutineStore.getByName`, new) and, if the
  `cron`/`prompt`/`channel`/`timeoutMs` match what was just requested,
  returns that row instead of raising — the earlier call already succeeded,
  so the retry now sees success too. Reconciliation only fires against an
  `active` existing row: a paused/inactive same-name row with otherwise
  identical fields still raises `RoutineNameConflictError`, because that is
  a genuine, separate collision (e.g. a paused "demo" routine plus a new,
  deliberate create under the same name), not the caller's own in-flight
  retry — silently reconciling there would report a successful create with
  no active schedule, which is a worse instance of the exact
  false-negative/false-positive problem this issue was filed to fix.
  Reconciliation deliberately does not additionally gate on the existing
  row's age/`createdAt`; see the code comment in `createRoutine` for why. A
  conflict with genuinely different fields still raises
  `RoutineNameConflictError` as before. Threading a
  request/trace correlation id through routine-turn error responses
  end-to-end (the issue's secondary ask) remains open — it would require a
  new field on the shared `ChatTurnInput`/`ChatTurnResult` contract
  (`@omadia/channel-sdk`) plus support in every channel adapter, which is
  broader than this fix. The literal error wording shown in Teams
  ("Etwas ist schief gegangen …") lives in the external Teams-channel
  adapter plugin and is out of scope for this repo.
  `isSameRoutineRequest`'s field comparison omitted `outputTemplate` — an
  independently-settable object field on both `Routine` and
  `CreateRoutineInput` (Phase C structured-output templates). A retried
  create that agreed on `cron`/`prompt`/`channel`/`timeoutMs` but carried a
  *different* `outputTemplate` (e.g. the caller adding or changing the
  structured template on an existing schedule) would reconcile to the old
  row and silently discard the new template while reporting success — the
  exact class of bug this issue exists to eliminate, on a field the fix's
  own comparison had missed. `isSameRoutineRequest` now compares
  `outputTemplate` too, via `node:util`'s `isDeepStrictEqual` (it is an
  object, so reference/`===` equality is not sufficient); an identical
  template (including the `null`/`null` case) still reconciles as before.
  The reconciliation check also ran too late: `createRoutine` evaluated the
  per-user quota (`countActiveForUser`) *before* attempting `store.create()`,
  so a retry from a user already sitting at `maxActivePerUser` — exactly the
  state their own successful-but-unconfirmed first call left them in — was
  rejected with `RoutineQuotaExceededError` before it ever reached the
  conflict-reconciliation logic, resurfacing the same false-negative under a
  different exception type. `createRoutine` now looks up
  `RoutineStore.getByName` and reconciles a same-request, `active` retry
  *before* the quota check and before calling `store.create()` at all — no
  new row is needed for a retry that already succeeded. The quota check
  still applies to every genuinely new routine request. The reconciliation
  logic in the `store.create()` catch block is unchanged and remains the
  necessary race-safety net for a concurrent request that creates the
  matching row between this proactive lookup and the insert.
  `isSameRoutineRequest` also excluded `conversationRef` from its
  comparison, reasoning it was a delivery-mechanism detail the caller
  doesn't control byte-for-byte. That's wrong on the cold-start outreach
  path: `ManageRoutineTool.handleCreate` resolves `conversationRef` from
  a caller-supplied `targetEmail` via `buildEmailColdStartTarget` before
  calling `createRoutine`, so it *is* caller-specified there. A create for
  a new `targetEmail` that otherwise matched an existing active routine
  (same tenant/user/name/cron/prompt/channel/timeoutMs/`outputTemplate`)
  would silently reconcile to the existing row and report success, while
  the new recipient was never set up and the routine kept messaging the
  original one — a silent-wrong-recipient bug. `isSameRoutineRequest` now
  compares `conversationRef` too, via `isDeepStrictEqual` (same rationale
  as `outputTemplate`: it is an object, and `buildEmailColdStartTarget`
  resolves deterministically per email, so deep equality correctly
  distinguishes a true retry from a different-recipient request).
- Review follow-up: `RoutineStore.create()` normalizes an omitted
  `conversationRef` to `{}` before persisting it (and reads it back the
  same way — `JSON.stringify(input.conversationRef ?? {})`), but
  `isSameRoutineRequest`'s new `conversationRef` comparison above compared
  the stored (normalized) value against the RAW retry input with no
  equivalent `?? {}` default, unlike `timeoutMs` and `outputTemplate`,
  which already apply the same default the store itself uses. On the
  ordinary (non-cold-start) create path — where `conversationRef` is
  legitimately `undefined`/omitted both on the original call and the retry,
  since only the `targetEmail` cold-start branch sets a non-default value —
  the stored `{}` never matched the retry's raw `undefined`, so the retry
  fell through to `RoutineNameConflictError`, reintroducing the exact
  false-negative issue #506 exists to fix for that path.
  `isSameRoutineRequest` now applies the same `?? {}` normalization the
  store uses: `isDeepStrictEqual(existing.conversationRef, input.conversationRef ?? {})`.

### Fixed — Teams-uploaded images now reach the model as vision input (#504, #505)

- Teams delivers inbound images via a Tigris `storage_key` + `[attachments-info]`
  manifest, never inline `bytesBase64`. The attachment auto-ingest path fetched
  those bytes but handed them to the text extractor, which correctly refuses
  images — so the fetched image was silently dropped and never reached the
  model, leaving the agent to falsely claim it couldn't see the image.
  `ingestAttachments` now routes image candidates through a new
  `checkVisionEmbeddable` guard (supported type + size cap) and embeds them
  as Anthropic vision content-blocks via `buildUserContent`, the same path
  Telegram's inline `bytesBase64` attachments already use (#504).
- Also implemented the `url`-fetch fallback that `chatAgent.ts` / `incoming.ts`
  document but the orchestrator never honored: an image attachment with a
  `url` and no pre-fetched `bytesBase64` is now fetched and embedded the same
  way. Latent today (no in-repo channel triggers it yet), but closes the gap
  before a future url-only channel (Slack, Discord, WhatsApp) ships broken
  vision silently (#505).
- Review round 2: neither path checked whether the active provider/model
  actually supports vision before building an image content-block, so a
  turn routed through a non-vision provider could still get an image block
  the API might reject or silently drop — reintroducing the same "agent
  can't see the image, nothing indicates why" failure. Both call sites now
  read `this.provider.capabilities.vision` and thread it through
  `ingestAttachments`/`buildUserContent`: when unsupported, no image
  content-block is built (avoids the provider rejecting the whole request),
  and image candidates aren't even fetched — but the attachment is never
  silently dropped either. A visible note (`[N image attachment(s) received
  but the active model does not support image input]`) is folded into the
  turn's text instead, so the model — and the user — knows an image existed
  and why it wasn't seen. `claude-cli`-routed turns (`CliChatAgent`, swapped
  in by `buildOrchestrator.ts` on `provider.id === 'claude-cli'`) take a
  separate code path that never calls `buildUserContent`/`ingestAttachments`
  at all; this change does not touch, fix, or regress that path.
- Review round 4: a fetched image candidate that failed the
  `checkVisionEmbeddable` guard (oversized, or an unsupported format
  such as SVG/BMP/TIFF) under a VISION-CAPABLE provider was only logged via
  `console.warn` and silently dropped otherwise — the same silent-drop
  failure #504 exists to close, just triggered by size/format instead of
  provider capability. `ingestAttachments` now also collects each
  rejection's reason, and `buildUserContent` folds a visible
  `[N image attachment(s) could not be shown: <reason(s)>]` note into the
  turn's text alongside (never instead of) the existing non-vision-provider
  note.
- Review round 6 (cross-vendor): the vision guard read
  `this.provider.capabilities.vision` — a flag on the PROVIDER CONNECTION,
  not the active MODEL. This is wrong whenever one connection serves
  multiple models with different vision support, which is not hypothetical:
  the bundled `mistral` openai-compatible connection serves
  `mistral-large-latest` and `mistral-medium-latest` (vision) alongside
  `mistral-small-latest` (no vision), yet `llm-adapter-openai`'s
  `openaiProvider.ts` hardcodes `capabilities.vision = true` on the
  connection regardless of the active model — so a turn on
  `mistral-small-latest` would still build an image block for a model that
  can't use it. `OrchestratorOptions` gained a new optional
  `visionSupported?: boolean` — the ACTIVE model's vision capability, meant
  to be resolved by the caller the same way `maxTokens` is already resolved
  per-model, since `harness-orchestrator` deliberately has no dependency on
  `@omadia/llm-provider`/`@omadia/llm-provider-api` and does not resolve the
  model registry itself. Both call sites now read `this.visionSupported ??
  this.provider.capabilities.vision` — an explicit per-model value would win
  if one were passed; omitting it preserves the exact prior provider-level
  behavior. **This is a mechanism, not an end-to-end fix**: as of this PR no
  real caller (`buildOrchestrator.ts`, `plugin.ts`, or any bundled config)
  sets `visionSupported` yet, so the concrete `mistral-small` scenario above
  is made fixable, not actually resolved in production today — a future
  change still needs to wire the active model's real vision capability
  through to `OrchestratorOptions` for any given connection. Backward
  compatible either way: no caller passing it is a no-op, not a regression.
- Review round 7: `checkVisionEmbeddable` compared the fetched image's RAW
  byte length against a 5MB cap, but that cap is Anthropic's documented
  per-image *base64-encoded* payload limit — comparing raw bytes against a
  base64-payload limit is the wrong unit, and rejected valid images (e.g. a
  ~5.5MB raw screenshot, ~7.3MB once base64-encoded) that were well under the
  real limit. The 5MB figure was also wrong for this deployment: the bundled
  Anthropic provider (`builtinLlmProviders.ts`) uses
  `https://api.anthropic.com` — the direct API, whose documented limit is
  10MB base64-encoded (5MB base64 applies only to Bedrock/Vertex). The guard
  now computes the base64-encoded size (`Math.ceil(rawBytes / 3) * 4`) and
  compares it against a corrected `MAX_VISION_IMAGE_BASE64_BYTES = 10MB`
  constant.

### Fixed — codegen: manifest capabilities[] now reflect per-tool spec flags (#507)

- `reproduceManifestCapabilities` (builder codegen) used to clone the
  boilerplate's `search` capability (`input_schema:{query}`,
  `side_effects:'read'`, `idempotent:true`, `autonomous:true`,
  `timeout_ms:20000`) onto every tool, substituting only id/description.
  `toolkit.ts` was generated correctly per-tool from the real Zod schemas,
  but `manifest.yaml`'s declared metadata was not: write tools shipped as
  `side_effects:'read'` + `autonomous:true`, misrepresenting their real
  behavior to anything that reads the manifest (marketplace listings,
  human reviewers, or any orchestrator-side consumer of these flags).
  `ToolSpecSchema` gained explicit `output`, `side_effects`, `idempotent`,
  `autonomous`, and `timeout_ms` fields (previously stripped silently by
  Zod's non-strict mode) so codegen can synthesise each `capabilities[]`
  entry from the real per-tool spec, falling back to the boilerplate
  defaults only for fields a tool omits. Applies uniformly to single- and
  multi-tool specs. `side_effects` is declared and passed through as the
  manifest's own `'read' | 'write' | 'none'` string enum (matching
  `agent-integration/manifest.yaml` and `agent-reference-maximum/manifest.yaml`),
  not a boolean — an earlier draft of this fix used a boolean field with a
  boolean-to-string mapping in codegen, which rejected valid spec/patch
  payloads shaped like the manifest's real contract.

### Added — Builder health score: context-quality decomposition, first slice (#499)

- `middleware/src/profileSnapshots/healthScore.ts` gained
  `computeContextQualityScore`, decomposing Builder agent-spec quality into
  the seven context-quality criteria from arXiv:2607.14275 ("AI Agents Do Not
  Fail Alone: The Context Fails First"): role clarity, guardrail coverage,
  instruction consistency, tool schema quality, grounding sufficiency,
  injection hardening, token efficiency. Each criterion carries a score (or
  `null` when not yet evaluated), a rationale, the failure mode it predicts,
  and a fix hint.
- Four criteria are deterministic and wired to existing subsystems:
  guardrail coverage (`boundaryPresets.ts` category coverage), tool schema
  quality (`manifestLinter.validateSpec` tool-id checks plus
  `agentSpec.validateSpecForCodegen`'s tools/external_reads namespace
  collision + reserved-id checks), grounding sufficiency (a knowledge-source
  attached-and-resolvable proxy on `permissions.graph.entity_systems` /
  `external_reads`, cross-checked against manifestLinter's
  `external_read_unknown_service` / `external_read_integration_missing`
  violations so an unregistered service doesn't score as "grounded"), and
  token efficiency (a persona-delta token budget via `personaCompose.ts`).
- Role clarity, instruction consistency, and the domain-coverage half of
  grounding sufficiency need judgment a deterministic check can't provide;
  they're returned as `evaluated: false` pending a future LLM-juror pass
  rather than faked with a proxy.
- Purely additive — `computeHealthScore` (the diff-based drift score
  `driftWorker.ts` persists) is untouched. Builder UI wiring and
  `driftWorker.ts` snapshot wiring are deferred to follow-up work; see #499.
### Fixed — templates v2 review round 3: owner-aware publish vs. auth timing (#478)

- The save-as-template dialog no longer reads the viewer's own template id as
  "taken" while the `getAuthMe` identity probe is still in flight. Ownership is
  now derived from live viewer state plus a new `viewerPending` flag: a
  user-sourced id collision holds a gated "Checking ownership" pending state
  (busy-dots, submit disabled) and flips to "Publish as v{n+1}" — or the
  id-taken error — once the viewer is known. Bundled/plugin collisions stay
  terminal, and the 409-race re-check keeps working (now also pending-aware).

### Fixed — templates v2 review round 2: input hardening, token placement (#478)

- `checkTemplateManifest` (conductor-core) no longer throws on malformed input:
  `POST /conductors/templates` with `{}` (or a manifest whose `slots` / kind
  lists / entries have the wrong shape) now returns a 400
  `conductor.template_invalid` envelope instead of a 500. The localized-text
  helpers moved to `conductor-core/src/localizedText.ts` (500-line rule; the
  `@omadia/conductor-core` export surface is unchanged).
- Save-as-template text slots are now actually publishable: the dialog gained a
  "Place text-slot tokens" section that edits the graph's designated step texts
  (`step.prompt`, `human.message`) with per-field insert buttons for each
  declared `slot:text:<key>` token, and blocks publish until every declared
  slot's token is placed — previously the manifest shipped without tokens and
  the backend rejected it as `template_text_slot_unused`.
- Stripped committed trailing whitespace from the conductor template test files
  (`git diff --check` hygiene).

### Changed — templates v2 review fixups: step-kind tokens, component splits (#478)

- The Conductor step-kind palette (agent/action/human node colors + badge text)
  moved from hardcoded hex in `ConductorCanvas`/`TemplatePreview` into Lume
  tokens (`--step-kind-*` in `web-ui/app/_lib/theme.css`), consumed through the
  shared `stepKindColors.ts` map — one source of truth, no per-component hex.
- Oversized web-ui files split per the 500-line rule, behavior-preserving:
  `SaveAsTemplateDialog` extracted its ref-/text-slot editor sections into
  `SaveAsTemplateSlotEditors.tsx`; `conductor/page.tsx` extracted the Roles
  (US6) and emit-event sections into `ConductorRolesSection.tsx` and
  `ConductorEmitSection.tsx`.

### Added — builder-chat template proposal cards (#478)

- `ConductorChatPane` (`web-ui/app/conductor/_components/`) renders B4's
  `templateProposals` as up to 3 compact cards under the assistant reply:
  locale-resolved template name, `v{n}` tag, the agent's one-line reason, and a
  slot-coverage line ("{filled} of {total} slots prefilled" — counted against
  DECLARED slots only, parity with the form's prefill seeding). One action,
  **"Use template"**, hands off to the instantiate form via the page's existing
  state plumbing (a prefill analog of the chat→canvas `setChatGraphRequest`
  hand-off): the form opens pinned to the proposed version with the proposal's
  prefill as `initialMapping`. Chat never auto-instantiates — creation stays a
  deliberate form action. A proposal whose template id no longer resolves in
  the catalog degrades to plain text (no dead action). Turns without proposals
  render byte-identically to before; the API client's builder-turn result type
  gains the additive `templateProposals` field.

### Added — instantiate form v2: text slots, graph preview, version pin, update hint (#478)

- `TemplateInstantiateForm` (`web-ui/app/conductor/_components/`) renders one
  required-fill input per declared **text slot** (`slots.text`), the declared
  default prefilled; an emptied defaulted slot is omitted from the mapping so
  the server substitutes the default. The client completeness gate mirrors
  `missingSlotMappings` (a text slot passes with a value OR a default), and the
  server's `kind:'text'` incomplete-mapping entries land inline on the right
  fields via the shared `text:<key>` flag ids. The submitted
  `TemplateSlotMapping` carries the additive `text` record.
- **Graph preview**: new `TemplatePreview` renders the MANIFEST graph — slot
  placeholders shown as their locale-resolved declared labels — into a small
  read-only designer canvas (no stored thumbnails), collapsed by default behind
  a "Preview graph" toggle so only an OPENED form mounts a flow instance. The
  plan drafted this on Cytoscape; the designer actually runs on
  `@xyflow/react`, so the preview is a locked-down React Flow reusing the
  canvas's node styling.
- **Versioning surface**: the form header shows the manifest version
  (`v{n}`); an explicit pinned version travels into `resolve`/`instantiate`.
  Workflows carrying B3's `template.updateAvailable` hint render
  "Template updated (v{n} → v{m})" (warning-colored text only, per Lume) with
  a **"Re-instantiate from v{m}"** action (`TemplateUpdateHint`) that opens the
  instantiate form pinned to the latest version — a deliberate NEW workflow;
  the existing instance keeps its copy (copy-not-reference).
- The form accepts an `initialMapping` prefill (consumed by the builder-chat
  template proposals, F4). API client: `mapping.text` + optional `version` on
  resolve/instantiate, `fetchConductorTemplateVersions`, and the additive
  `template` hint on the workflow wire type.

### Added — template gallery v2: facets, pending-review queue, search, manage actions (#478)

- `TemplateGallery` (`web-ui/app/conductor/_components/`) now renders the
  composite catalog with **provenance facets** (All / Bundled / My templates /
  Shared / Plugins / **Pending review**), client-side **text search** over the
  locale-resolved name/description/useCase, and secondary **use-case chips**.
  "My templates" derives ownership from `createdBy = viewer` (viewer identity
  via the page's existing `getAuthMe` plumbing), falling back to "a visible
  private template is the viewer's own" per the backend visibility rule.
- **Pending review is the reviewer queue**: every `status = 'pending'` user
  template is listed for EVERY operator (the install-wide pending visibility
  rule makes the review gate reachable by non-author reviewers), with the
  submitter shown and **Approve / Reject** actions directly on the card — not
  inside an author-only menu. The facet label carries a waiting-count badge;
  empty state: "No templates waiting for review".
- Cards gain a provenance/status badge (text + edge color only, per Lume), a
  `v{n}` tag, an instantiation count ("Used {n}×"), and author manage actions
  on own user templates: **Submit for review** (private only) and **Delete**
  behind an inline confirm. All mutations refetch the catalog through the
  page (`onCatalogChanged` → `reload()`); errors surface inline as text with
  the server's error message.
- API client (`web-ui/app/_lib/api.ts`): `deleteConductorTemplate`,
  `submitConductorTemplate`, `approveConductorTemplate`,
  `rejectConductorTemplate` over B3's review-gate routes.

### Added — save-as-template dialog in the Conductor admin UI (#478)

- Published workflows in the Conductor page's workflow list gain a **"Save as
  template"** action (only with an active published version). It opens
  `SaveAsTemplateDialog` (`web-ui/app/conductor/_components/`), seeded by the
  backend's inference draft (`POST /:slug/save-as-template`): metadata with
  separate en/de inputs (en required — the manifest's universal fallback; de
  present → a `LocalizedText` record travels, absent → a plain string), the
  inferred ref slots grouped per kind with editable en/de labels and the
  original concrete ref shown as context, and a manual text-slot editor
  (key/label/default, with the paste-able `slot:text:<key>` token shown per
  row — text slots are never inferred).
- **Owner-aware primary action** (the v2 version-publish path): the entered id
  is resolved against the loaded viewer-scoped catalog — unused id → "Publish
  template" (`POST /templates`); an existing USER template with
  `createdBy = viewer` → **"Publish as v{latestVersion+1}"**
  (`PUT /templates/:id`, with a copy-not-reference note that existing
  instances are unaffected and will show an update hint); bundled/plugin/
  foreign id → inline "id taken" error, primary disabled. A **409 race** on
  POST re-fetches the template (`GET /templates/:id`) and, when it turns out
  viewer-owned, switches the dialog into the PUT state instead of
  dead-ending. Viewer identity comes from `GET /auth/me` (`user.id` = the
  session `sub` the backend scopes the catalog by).
- API client (`web-ui/app/_lib/api.ts`): `saveWorkflowAsTemplate`,
  `createConductorTemplate`, `updateConductorTemplate`,
  `fetchConductorTemplate`; `ConductorTemplate` widened with the additive
  catalog metadata (`source/status/createdBy/version/latestVersion/
  instantiationCount/updatedAt`) and `slots.text`
  (`ConductorTemplateTextSlot`). Lume throughout (state colors text/edge
  only, Button busy verb+dots, `.lume-skeleton` while the draft loads); all
  strings i18n'd en+de. Tests:
  `__tests__/SaveAsTemplateDialog.test.tsx` (draft rendering, POST manifest
  shape incl. text slot + de label map, owned-id PUT switch, foreign/bundled
  dead-end, 409-race recovery both ways, missing-en gate, busy-dots).

### Added — builder-chat template awareness (#478)

- The Conductor conversational builder (`src/conductor/builderAgent.ts`) now
  sees the workflow-template catalog: its system prompt carries a compact,
  **viewer-scoped** catalog digest (id, en-resolved name/useCase, version,
  slot list incl. text slots; capped at 30 templates with a count note), and
  the reply protocol accepts an additional `templateProposals` block.
  `POST /builder/turn` returns it **additively** as
  `templateProposals?: [{ templateId, version, reason, prefill }]` — the key
  is absent entirely when there are no proposals, so the v1 wire shape stays
  byte-identical for existing consumers.
- The proposals are server-side gated inside the agent seam (defensive, never
  throws): unknown or viewer-invisible template ids are dropped against the
  composite catalog, duplicates deduped, at most 3 survive, `version` is
  catalog-authoritative (the LLM's claim is ignored), and `prefill` guesses
  are kept only for declared slot keys whose ref values resolve against the
  live `KnownRefs` sets (`channels` has no KnownRefs set → structural
  acceptance, mirroring `validate()`). A stripped guess renders as an empty
  form field, never a broken one. A failing catalog/KnownRefs read degrades
  to a template-less turn instead of a 500. Chat proposes and prefills only —
  instantiation stays on the existing `resolve`/`instantiate` form flow, no
  auto-instantiation. The shared `templateKnownRefs` function is hoisted in
  `src/conductor/index.ts` so the builder's prefill vetting and the template
  routes' strict validation can never drift apart. Tests: extended
  `test/conductorBuilder.test.ts` (digest visibility incl. pending/foreign-
  private, proposal vetting, malformed blocks, no-proposal regression).

### Added — template authoring, review gate, plugin-borne templates, update hint (#478)

- **Save as template** (`POST /:slug/save-as-template` on the conductor
  router — it is mounted at `/api/v1/operator/conductors`, so there is no
  `/workflows` path prefix): loads the workflow's active published version and
  returns an `inferTemplateManifest` **draft** (`{ draft, sourceWorkflow:
  { slug, version } }`) with one declared slot per distinct concrete ref
  (label = the original ref). Nothing is persisted — the UI edits the draft
  and publishes via `POST /templates` (fresh id) or `PUT /templates/:id`
  (new version of an owned id). Body overrides `{ id?, name?, description?,
  useCase? }`; the default id derives from the slug with a `-template` suffix
  on collision; `404 conductor.workflow_not_found` without a published version.
- **Review state machine** (Make's team-template shape, `private → pending →
  shared`): `POST /templates/:id/submit` (author-only; `409
  conductor.template_status_conflict` from any status but `private`),
  `POST /templates/:id/approve` / `reject` (**any authenticated operator** —
  reachable because `pending` templates are visible install-wide; resolved
  through the viewer-scoped catalog `get`, so a non-author reviewer never
  404s). `reviewed_by` is recorded for audit; self-approval stays permitted
  (single-operator installs must not deadlock, separation of duties is an
  explicit deferral). A reject by a non-author flips the template `private`
  and out of the reviewer's visibility — the response then carries
  `template: null`.
- **Template update hint**: workflow list (`GET /`) and detail (`GET /:slug`)
  additively report `template?: { id, version, latestVersion,
  updateAvailable }` when the row carries `template_id`/`template_version`
  provenance. Viewer-scoped: a template the viewer cannot see degrades to
  `latestVersion = version, updateAvailable: false` (no existence leak).
  Copy-not-reference stands — the hint powers deliberate re-instantiation,
  never silent propagation.
- **Plugin-borne workflow templates** — the designed trust boundary (recorded
  in `docs/security-architecture.md` §4): plugins declare TemplateManifest
  JSON files under `permissions.templates` (package-relative paths). Install
  is gated **fail-closed** in the new `src/plugins/pluginTemplates.ts`:
  `.json` only, path confinement after symlink unwrapping, id namespacing
  `plugin:<pluginId>:<name>` (no shadowing of bundled/user ids),
  `checkTemplateManifest({ strict: true })` (undeclared concrete refs
  rejected as confusion/exfiltration vectors), `isValidCron` on cron
  triggers; any violation fails the install with `install.template_invalid`.
  Accepted manifests register as read-only `source: 'plugin'` catalog entries
  (write paths 403), are removed on uninstall, and re-register at boot
  (fail-open per template — the hard gate ran at install time). Templates are
  data, never code: no runtime template API, nothing executed. Tests:
  `test/pluginTemplates.test.ts` (new; gate incl. symlink escape,
  InstallService integration, boot sweep) + extended
  `test/conductorTemplateRoutes.test.ts` (state machine incl. non-author
  approve, inference round-trip, update hint, plugin source read-only).

### Added — DB-backed workflow templates: store, composite catalog, CRUD + versioning routes (#478)

- New Conductor migration **`0006_templates.sql`** (conductor chain,
  `_conductor_migrations`; verified free against open PRs — the top-level
  chain's `0022` belongs to PR #476 and is not used here): `conductor_templates`
  (owner, review `status` `private|pending|shared` — TEXT without CHECK, growable
  enum per the #470 lesson, `latest_version`, `reviewed_by`),
  `conductor_template_versions` (immutable JSONB manifest snapshots,
  PK `(template_id, version)`, mirroring the workflow version store),
  `conductor_template_instantiations` (append-only anonymous telemetry with
  denormalized `template_name` so rows survive deletion — the `0009_mcp_call_log`
  pattern), plus `template_id`/`template_version` provenance columns on
  `conductor_workflows`. Idempotent (`IF NOT EXISTS`), forward-only. The
  conductor migrations dir is now also mirrored into `dist/` by
  `copy-build-assets.mjs` (previously Dockerfile-COPY only, so a plain
  `npm run build` dist missed it).
- New `src/conductor/templateStore.ts` (`createTemplateStore(pool, log)`):
  create (unique violation → typed 409), atomic `addVersion`
  (`latest_version + 1` under `FOR UPDATE`), get/list/delete/setStatus,
  `listVersions`/`getVersion`, `recordInstantiation` + `instantiationCounts`,
  and `stampWorkflowProvenance` (runs on the publish transaction's client).
  The `version` column is authoritative — it is stamped into
  `manifest.version` at write and read, so the JSONB can never drift.
- `templateCatalog.ts` gains the **composite catalog** (bundled files + DB user
  templates + a plugin registration seam for #478 B3) behind a viewer-scoped
  `{ list(viewer), get(id, viewer) }`. **Visibility rule (the reviewer-reachable
  review gate):** bundled/plugin → everyone; a user template is visible iff
  `shared` OR `createdBy = viewer` OR **`pending`** — every operator on the
  single-tier operator API is a potential reviewer, so pending submissions are
  visible install-wide; only foreign `private` templates are hidden. `get`
  applies exactly the list's rule (no 404-vs-list divergence).
- Template routes (split into `src/conductor/templateRoutes.ts` for file size;
  same mount + order, before the `/:slug` catch-all): `GET /templates` now
  serves `TemplateSummary` = manifest + ADDITIVE `source`/`status`/`createdBy`/
  `version`/`latestVersion`/`instantiationCount`/`updatedAt` (v1 fields
  untouched — #330 contract-tested); new `GET /templates/:id`,
  `POST /templates` (private create, `409 conductor.template_id_exists`,
  `400 conductor.template_invalid`), `PUT /templates/:id` (author-only version
  bump; sharing status deliberately unchanged — the gate governs sharing, not
  each version), `DELETE /templates/:id` (author-only, user source only),
  `GET /templates/:id/versions`; `resolve`/`instantiate` accept an optional
  body `version` (default latest). `instantiate` stamps `{template_id,
  template_version}` provenance inside the same transaction as the publish and
  appends a best-effort telemetry row. Viewer identity: `req.session?.sub ??
  'operator'`. Tests: `test/conductorTemplateStore.test.ts` (new, stateful
  fake-pool) + `test/conductorTemplateRoutes.test.ts` (real composite catalog;
  explicit reviewer-reachability cases incl. "pending template of A is listed
  and gettable by B").

### Added — template contract v2: versioning, text slots, slot inference, strict import gate (#478)

- `@omadia/conductor-core` extends the workflow-template contract for templates
  v2, purely additively over the #429 v1 surface: `TemplateManifest.version`
  (integer ≥ 1, absent = 1 — read via the new `templateManifestVersion()`),
  declared **text slots** (`slots.text`, referenced as `slot:text:<key>` tokens
  inside the designated text fields `step.prompt` / `step.human.message` only,
  disjoint from `{{...}}` run-context interpolation, with optional per-slot
  `default`), `TemplateSlotMapping.text` for their instantiation values, and
  `missingSlotMappings` reporting unfilled text slots as `kind: 'text'` entries.
  `checkTemplateManifest` now validates text-slot declaration/usage both ways
  (`template_text_slot_undeclared` / `template_text_slot_unused`) and gains a
  `{ strict: true }` mode for distributed (plugin/hub-imported) manifests that
  rejects any concrete ref left in the five ref fields
  (`template_concrete_ref_in_strict_mode`) — undeclared install-local refs are
  confusion/exfiltration vectors, so distributed templates must declare every
  external ref as a slot. New `inferTemplateManifest(graph, opts)` reverses the
  `extractSlotRefs` walk for "save as template": each distinct concrete ref
  becomes a declared slot with a slugified, de-duplicated key (pre-existing
  `slot:` placeholders pass through), round-trip covered by tests. Pure
  functions only; text-slot machinery lives in the new `src/textSlots.ts`,
  v2 tests in `test/templateV2.test.ts`.

### Fixed — template instantiation slug race can no longer republish over a fresh workflow (#429)

- Two concurrent `POST /templates/:id/instantiate` with the same not-yet-existing
  slug could both pass the route's `getBySlug` pre-check; the loser then fell
  into `createOrPublish`'s `ON CONFLICT DO UPDATE` upsert and silently published
  a second version over the just-created workflow, answering 201 — violating the
  route's own create-new contract. The 409 is now enforced **atomically**:
  `createOrPublish` gains a create-only mode (`expectNew: true` →
  `INSERT … ON CONFLICT (slug) DO NOTHING`; zero returned rows aborts the publish
  transaction with the new `WorkflowSlugExistsError`), the instantiate route drops
  the racy pre-check entirely and maps the error to the existing
  `409 conductor.slug_exists` envelope. `POST /` and the canvas save path keep
  their idempotent upsert untouched. Store-level tests (fake-pool, SQL-shape
  scripted) in `middleware/test/conductorWorkflowStore.test.ts` (new); route
  mapping covered in `middleware/test/conductorTemplateRoutes.test.ts`.

### Fixed — template metadata is localizable in the manifest; bundled templates ship German (#429)

- Template name, description, `useCase` tag, and slot labels/help texts rendered
  raw English strings from the bundled manifests in the German UI. Because
  templates are data (v2 distributes them outside the repo), localization now
  travels **in the manifest**: those fields accept a plain string or an
  `{ en, de?, … }` record with `en` required as the universal fallback
  (`LocalizedText` + `resolveLocalizedText` in `@omadia/conductor-core`;
  `checkTemplateManifest` validates the shape with the new
  `template_invalid_localized_text` code). All four bundled manifests carry
  proper German translations, and the catalog CI gate now asserts bundled en/de
  parity. `GET /templates` keeps returning full, unresolved manifests
  (machine-readable contract for #330) — the gallery and the slot-mapping form
  resolve the active locale client-side via next-intl's `useLocale()` with en
  fallback (`resolveConductorText` in `web-ui/app/_lib/api.ts`); the instantiate
  route resolves its manifest-borne name/description fallbacks to the en base
  before persisting. Missing-slot error envelopes keep flat English labels
  (clients localize by kind+key). Tests: conductor-core `template.test.ts`,
  `conductorTemplateCatalog.test.ts` (parity gate), and de-locale/en-fallback
  component tests for `TemplateGallery` and `TemplateInstantiateForm`.

### Fixed — "Open in designer" no longer drops the template form's enable=OFF default (#429)

- The template slot-mapping form's "Open in designer" handoff only passed
  graph/slug/name to `ConductorCanvas`, whose save path hardcoded
  `publishConductorWorkflow({ ..., enable: true })` — so a cron template left
  on the default-off enable toggle was created **enabled** on Save and started
  its schedule without the form's schedule notice ever applying. The form now
  hands its `enable` choice along (`onOpenInDesigner` target +
  `CanvasGraphRequest.enable`), and the canvas publishes with it. Requests
  without an `enable` choice (chat drafts, US7) and the edit-existing path
  keep the historical enabled-on-save behaviour (the store only applies
  `enable` on first create anyway). Regression tests in
  `web-ui/app/conductor/_components/__tests__/ConductorCanvas.test.tsx` (new)
  and the form tests.

### Added — workflow-template slot-mapping form on /conductor (#429, unit f2)

- Picking "Use template" on `/conductor` now renders the guided instantiation
  form (`web-ui/app/conductor/_components/TemplateInstantiateForm.tsx`) inline
  below the gallery: ONE upfront mapping form for the whole template (never
  per-node walking) with prefilled slug/name fields and one picker per declared
  slot, grouped by kind — roles/agents/actions/events fed by the existing
  designer catalog fetchers (`getConductorRoles` / `getConductorAgents` /
  `getConductorActions` / `getConductorEventCatalog`), channels via the shared
  `ChannelSelect` (prefilled `teams` so the mapping state matches the select's
  display). Three actions: **Create workflow** (primary →
  `POST /templates/:id/instantiate`, then the list reloads), **Open in
  designer** (secondary → `POST /templates/:id/resolve`; the resolved graph
  hydrates `ConductorCanvas` through the existing chat→canvas
  `loadGraphRequest` mechanism — extended with optional `slug`/`name` so the
  canvas form arrives publish-ready under the template instance identity and
  never republishes over a previously loaded workflow's slug; publish then
  goes through the canvas's normal save flow) and **Cancel** (ghost). Enable toggle defaults to OFF; with a
  cron-triggered template and the toggle ON, a persistent warning-colored TEXT
  notice states that the schedule starts as soon as the workflow is created.
  Client gate mirrors the server's completeness check (slug + every slot
  mapped); the b3 error envelope maps to inline errors — missing slots flagged
  field-level (error text + border only), `conductor.slug_exists` (409) on the
  slug field, `conductor.invalid_graph` as a message list. In-flight = verb +
  animated dots via the Button busy recipe (no spinners). i18n en+de under
  `conductor`; Vitest tests in
  `app/conductor/_components/__tests__/TemplateInstantiateForm.test.tsx`.

### Added — workflow-template gallery on /conductor (#429, unit f1)

- The `/conductor` admin page gains a "Workflow templates" section above the
  workflows list: a card grid (`web-ui/app/conductor/_components/TemplateGallery.tsx`)
  rendering the bundled catalog from `GET /templates`. Each card answers "what
  problem does this solve and what will I need to map" before commit — name,
  `useCase` tag, description, a pluralized "You will map: 2 roles · 2 agents ·
  1 channel" slot summary, and a text/edge "Runs on a schedule" badge for
  cron-triggered templates. An empty catalog renders nothing (no empty-state
  noise). "Use template" stores the selection for the slot-mapping form
  (follow-up unit f2). API client (`web-ui/app/_lib/api.ts`) mirrors the
  `TemplateManifest` wire shape locally (web-ui does not depend on
  `@omadia/conductor-core`) and ships all three fetchers —
  `fetchConductorTemplates`, `resolveConductorTemplate`,
  `instantiateConductorTemplate` — so f2 only builds UI. i18n keys under the
  `conductor` namespace in `messages/en.json` + `messages/de.json`; Vitest
  component tests in `app/conductor/_components/__tests__/`.

### Added — conductor workflow-template routes (#429, unit b3)

- Three new operator routes on the auth-gated `/api/v1/operator/conductors`
  (registered before the `/:slug` catch-all): `GET /templates` (full manifests
  incl. graph + slot declarations — machine-readable for #330),
  `POST /templates/:id/resolve` (ephemeral instantiation: substitute the slot
  mapping, validate, return the graph, persist nothing) and
  `POST /templates/:id/instantiate` (publish through the ordinary
  `createOrPublish` path incl. the atomic cron-schedule reconcile; `enable`
  defaults to `false`, `name`/`description` default to the manifest). Error
  contract: `404 conductor.template_not_found`,
  `400 conductor.template_slot_mapping_incomplete` with
  `missing: [{ kind, key, label }]`, `400 conductor.invalid_graph` with the
  existing `unknown_*_ref` codes, `400 conductor.invalid_input` on a missing
  slug and `409 conductor.slug_exists` on a slug collision (deliberate
  divergence from `POST /`'s upsert — instantiation means "create new"). Both
  template routes validate with **live `KnownRefs`** (registry agent slugs,
  action ids, role keys, event catalog) — stricter than `POST /`'s structural
  validation on purpose: a template instance must be runnable, not merely
  well-formed. Wired in `wireConductor`
  (`middleware/src/conductor/index.ts`); route tests with stubbed deps in
  `middleware/test/conductorTemplateRoutes.test.ts`; API documented in
  `docs/middleware-agent-handoff.md` §3.

### Added — bundled conductor workflow-template catalog (#429, unit b2)

- Four curated workflow-template manifests ship as JSON assets in
  `middleware/src/conductor/templates/`: `expense-approval` (manual trigger,
  summarize → approve with 48h deadline → escalation → outcome announcement),
  `notify-and-escalate` (event trigger, triage → acknowledge with hourly
  reminders and 4h deadline → escalation), `weekly-report` (cron `0 8 * * 1`,
  compose → review) and `onboarding-checklist` (sequential HR → IT → manager
  checklists with daily reminders → confirmation). New loader
  `middleware/src/conductor/templateCatalog.ts` scans the dir next to its own
  compiled module (same dirname-relative pattern as the conductor migrator),
  runs `checkTemplateManifest` on every file, and skips invalid/unparsable
  assets with a `[conductor] template <file> invalid: …` log line instead of
  failing boot; `middleware/test/conductorTemplateCatalog.test.ts` is the hard
  CI gate (manifest integrity, synthetic-mapping end-to-end instantiability
  incl. `validate()` with live-style KnownRefs, cron validity, unique
  kebab-case ids, loader skip/duplicate behavior). Build plumbing in the same
  change: `middleware/scripts/copy-build-assets.mjs` mirrors the dir into
  `dist/conductor/templates` — that alone covers the Docker image too, since
  the builder stage runs `npm run build` and the runtime stage copies the
  resulting `dist/` (no Dockerfile change). File-based catalog — **no DB
  migration** (the conductor chain's next free number stays `0006`).

### Added — conductor-core workflow-template contract (#429, unit b1)

- `@omadia/conductor-core` gains the shared workflow-template contract:
  `TemplateManifest` / `TemplateSlots` / `TemplateSlotMapping` types plus pure
  helpers in `src/template.ts` — `extractSlotRefs` (structural walk of the five
  ref fields `step.agentId`, `step.actionId`, role `step.human.principal.ref`,
  `step.human.channel`, `trigger.eventId`), `missingSlotMappings`,
  `applyTemplateSlots` (deep-clone, field-targeted `slot:<kind>:<key>`
  substitution; never touches `{{ctx.*}}` prompt/message interpolation) and
  `checkTemplateManifest` (metadata + structural validate + bidirectional slot
  coverage). Foundation for the file-based template catalog and the
  `/templates` middleware routes (follow-up units on the same branch).

### Added — advisory SkillSpector code scanning for plugin packages (#453)

- Every ingested plugin package (direct upload, hub install, Builder install)
  is optionally scanned by an NVIDIA SkillSpector sidecar
  (`middleware/sidecars/skillspector/`, enabled via `SKILLSPECTOR_URL` /
  `docker-compose.skillspector.yaml`). Fire-and-forget after ingest success —
  a scanner outage records a `scan_failed` verdict and never fails an
  install; with `SKILLSPECTOR_URL` unset nothing is scheduled and NO verdict
  row is written (store pages show no badge on unconfigured deployments).
  The shim and the middleware parser are **fail-closed**: only the
  positively-verified SkillSpector report schema (exit 0, `issues` list +
  `risk_assessment` object — observed against the pinned commit, CLI
  v2.3.11) counts as a scan; any unrecognized output surfaces as
  `scan_failed`, never as a false `no_signals` all-clear. Coverage of the
  executed entry point is guaranteed the same way: upload validation
  rejects a `lifecycle.entry` below `node_modules`/hidden directories
  (`package.entry_unscannable`), and the scanner force-includes the entry
  file when the directory walk skipped it — failing closed (`scan_failed`)
  when it cannot. The sidecar
  dependency is pinned to an exact upstream commit SHA (pin-bump procedure:
  sidecar README). Verdicts are cached by ZIP sha256 + scanner version
  (**migration `0021_plugin_verdict.sql`**, table `plugin_verdicts` incl.
  inline operator ack columns), surface as a badge + `verdict` field on
  `GET /api/v1/store/plugins/:id`, and can be acknowledged via
  `POST /api/v1/store/plugins/:id/verdict/ack`. An ack records the severity
  the operator saw (`ack_severity`) and is cleared automatically when a
  later re-scan WORSENS the verdict; it survives equal-or-better results.
  Advisory-only in v1: nothing blocks. New env vars: `SKILLSPECTOR_URL`,
  `SKILLSPECTOR_TIMEOUT_MS`.

### Added — free-text user-prompt PII masking, default off (#361)

- `harness-plugin-privacy-guard` 0.3.0: new **default-off** setup field
  `mask_user_prompt`. When on, PII spans detected in the user's own message
  (C0 regex baseline: email, IBAN, phone, German street+postal address,
  amounts, DOB dates) are replaced by realistic pseudonyms before the prompt
  crosses the LLM wire (pseudonym projection via the shipped `v4/pseudonym`
  mechanism — no on-wire token map); the real values are restored
  server-side in the final answer, and the spans surface (PII-free) as
  `maskedPromptSpans` on the `PrivacyReceipt`. Failure-closed: C1-detector
  failure degrades to C0 with audit; a baseline failure or residual span
  blocks the turn — there is no pass-through-unmasked path. Flag-off is
  byte-identical to previous behavior.
- Orchestrator: every LLM-bound site (message assembly, **live chat
  history/`priorTurns` — which replays persisted REAL values from earlier
  turns**, ingested attachment tail, **mid-turn steering messages injected
  via `POST /chat/steer`** (masked through the same per-turn map before the
  iteration loop folds them into the conversation), model/persona routing,
  KG-recall query, recalled-context injection, **direct-line relay
  payloads**, fact-extraction prompt, nudge pipeline, card router, excerpt
  pass) consumes the masked wire variant. Server-side persistence stores real
  values only: the session log / KG persist the POST-restore answer,
  extracted facts and the Palaia excerpt are restored surrogate→real before
  ingest/promotion (fire-and-forget extraction uses a snapshot of the
  turn's map, `snapshotPromptRestorer`), and receipt attribution keeps the
  original text. User-facing card content (`ask_user_choice` question/
  options, follow-up buttons) is restored surrogate→real before rendering.
  Direct-line turns mask the relayed payload before dispatch, restore the
  sub-agent's answer, fail closed (generic privacy error, audited) when
  masking is blocked, and mask the fact-extraction inputs the same way.
  Streamed deltas may transiently show a surrogate; the `done` answer is
  authoritative (same contract as the v4 rendered-answer swap).
- Committed runnable validation harness with pre-committed gates:
  `harness-plugin-privacy-guard/src/validation/` (not a CI gate). Current
  coverage: `de` + `en` fixture sets, **C0 regex tier only** — the C1
  transformer slot (Piiranha/GLiNER) is an inert stub. Gates: recall ≥ 0.97
  for structured identifiers, ≥ 0.90 for names/free-form entities (needs
  C1 — C0 does not detect names), precision proxy ≥ 0.85 on PII-free
  negatives, p95 added latency ≤ 400 ms. Enabling `mask_user_prompt` for a
  locale requires posting a green harness run for that locale to issue
  #361 first.

### Added — GLiNER PII-detector sidecar for prompt masking (#361)

- New optional inference sidecar `middleware/sidecars/pii-detector/`
  (skillspector pattern: stdlib-only HTTP shim, stateless, fail-closed):
  runs `urchade/gliner_multi_pii-v1` (Apache-2.0, quantized ONNX backend by
  default, torch fallback) and answers `POST /detect` with scored
  `person`/`address` spans as Unicode code-point offsets — the C1
  transformer tier that detects the PII classes the C0 regex baseline
  structurally cannot (names, free-form addresses). Model + deps are pinned
  to exact versions and baked into the image at build time (pinned HF
  revision, `HF_HUB_OFFLINE=1` — the running container performs no egress).
  Enable via the `docker-compose.pii-detector.yaml` overlay, which keeps the
  sidecar internal-network-only (no published ports — it receives raw prompt
  PII; request text and span values are never logged) and sets the new
  middleware env var `PRIVACY_C1_DETECTOR_URL`. Without the overlay the
  default stack is unchanged; sidecar down at runtime means the audited
  degrade-to-C0 path (`promptMaskDegraded`), never a silent unmasked
  pass-through.
- `harness-plugin-privacy-guard` 0.4.0: the sidecar is wired into the
  shipped `PromptPiiDetector` seam via a new fail-closed HTTP client
  (`createC1HttpDetector`, detector id `c1-gliner`) injected through the
  existing `createPrivacyGuardService({c1Detector})` slot — no service-,
  mask- or orchestrator-logic changes. New non-secret setup field
  `c1_detector_url` (live-read per call; `PRIVACY_C1_DETECTOR_URL` env
  fallback; empty ⇒ C0-only, no C1 call attempted) and one deliberate
  `permissions.network.outbound` entry for the sidecar (the plugin was
  previously pure compute). The client positively validates the sidecar's
  response schema and converts its Unicode code-point offsets to UTF-16
  exactly, asserting per span that the converted slice reproduces the
  sidecar's text — any mismatch, timeout (default 1500 ms), non-200 or
  malformed body throws and rides the audited degrade-to-C0 path.

### Added — 6-locale prompt-PII validation build-out (#361)

- The runnable validation harness
  (`harness-plugin-privacy-guard/src/validation/`, still NOT a CI gate) now
  covers all six target locales: fixtures for fr/es/it/nl plus scaled-up
  de/en — 121 items per locale (89 positives incl. a 25-item hand-built
  out-of-distribution slice, 32 PII-free negatives). All committed fixtures
  are original (hand-built + LLM-generated synthetic); no ai4privacy rows or
  derivatives are committed (restricted commercial terms — local uncommitted
  use only). fr/es/it/nl carry a recorded "native-speaker spot-check
  pending" caveat. Locale ID numbers (Steuer-ID, NINO, NIE/DNI, codice
  fiscale, BSN) are typed `idnum` and measured informationally, never gated
  in v1.
- Harness extensions: with `PII_DETECTOR_URL` set, the eval adds a `c0+c1`
  set (person recall ≥ 0.90 now enforceable, plus the shipped structured /
  precision / latency gates) and a `c1-solo` ablation (reported, never
  gated); one un-timed warm-up call per set keeps model warm-up out of p95;
  `--markdown` emits GitHub-flavored tables for posting run results to
  issue #361. Fixture files are linted at load (verbatim span values, known
  types/tiers, duplicate rejection) and a malformed file fails the run
  loudly. Without `PII_DETECTOR_URL` the harness runs c0-only exactly as
  before: de/en still PASS their structured gates, while the fr/es/it/nl
  runs now honestly document the C0 baseline's locale gaps (French
  space-grouped amounts, Dutch address/date formats, Spanish local phones)
  in the validation README instead of the fixtures being softened. The
  per-locale flag policy is unchanged: results posted to #361 before any
  locale flips `mask_user_prompt` on.

### Fixed — prompt-mask overlap resolution kept only the winning span (#361)

- `promptMask.ts#dedupSpans` resolved detector overlaps by dropping the
  lower-confidence span wholesale. A long C1 span (e.g. a free-form address
  GLiNER scored 0.8) that merely brushed a short confidence-1 C0 hit inside
  it (the postal code) therefore lost its ENTIRE coverage — the rest of the
  address reached the LLM wire unmasked, and the post-mask residual check
  only asserts kept values, so it could not catch the drop (review finding
  on the #361 branch). Overlap resolution now lets the winner own only the
  contested characters: every uncovered remainder of a losing span is kept
  as a masking span of its own (word-boundary re-extended, output still
  non-overlapping). Regression tests cover the exact reviewer scenario at
  both the `dedupSpans` and the `maskPrompt` level.

### Added — recorded 6-locale validation run (#361)

- `harness-plugin-privacy-guard/src/validation/RESULTS.md` commits the full
  `c0` / `c0+c1` / `c1-solo` × 6-locale harness run (2026-07-10, pinned
  GLiNER ONNX model, sidecar defaults, dedup fix included): **de/en/it pass
  ALL gates on `c0+c1`** (person recall 100% incl. the hand-built OOD
  slice); es/fr/nl fail on recorded C0 structured locale gaps (amounts /
  dates / phone formats), not on C1 quality; the `c1-solo` ablation
  confirms C0 stays load-bearing for structured identifiers. The flag
  policy is unchanged — these tables must be posted to issue #361 before
  any locale flips `mask_user_prompt` on; the validation README now links
  the recorded run.

### Added — privacy receipt card shows masked prompt spans (#361)

- The chat privacy-receipt card now surfaces the backend receipt field
  `maskedPromptSpans` (shipped with the prompt-masking runtime path, but
  until now unknown to the frontend mirror): a collapsed summary chunk
  ("prompt: N masked") plus an expanded fact row with a per-type breakdown
  (e.g. "3 (2 × person, 1 × email)"). Span types are an open set rendered
  verbatim; detector ids stay in the data and are not rendered. A dedicated
  explainer line states that identifiers in the user's own message were
  pseudonymised before the model call and restored in the answer. Absent or
  empty field ⇒ the card renders byte-identically to before. New
  `privacyReceipt.{summaryPromptMasked,factPromptMasked,explainerPromptMasked}`
  i18n keys in en + de.

### Changed — v1.0 readiness pass across the earliest core plugins (#431)

- `harness-plugin-web-search`, `harness-plugin-privacy-guard`, and
  `harness-plugin-quality-guard` now ship READMEs (purpose, config keys,
  published capabilities/tools, recorded `ctx.jobs`/`ctx.status`/`ctx.llm`/
  `ctx.mcp` adopt-or-skip decisions).
- `agent-seo-analyst`: operator-catalog `identity.description` translated to
  English; README gains the same PluginContext-surface audit section.
- `harness-plugin-privacy-guard`: `package.json` version aligned to the
  manifest (`0.2.0` at the time of #431; both sit at `0.3.0` after the #361
  bump in this branch); the v4 path (`src/service.ts` + `src/v4/`) is
  declared the single canonical implementation — no legacy branch exists
  (see README).
- Recorded decisions: plugins stay independently versioned (no lockstep bump
  with core); package layout is per-kind (tool plugins `src/`→`dist/`, agent
  packages flat, per `agent-reference-maximum` + boilerplate templates).

### Added — pluggable LLM provider (OpenAI as an admin-selectable provider)

- **`@omadia/llm-provider`**: a neutral LLM provider contract with Anthropic and
  OpenAI adapters (the OpenAI adapter also serves OpenAI-compatible endpoints —
  Mistral / Ollama / vLLM / Azure — via a `baseURL`), a global provider-qualified
  model registry (`anthropic:…` / `openai:…`, capability classes
  `fast|balanced|frontier`, role defaults), and a `resolveLlmProvider` factory
  that builds the right adapter from vault credentials.
- **Provider-namespaced vault credentials** (`provider:<id>/api_key`) with an
  idempotent migration off the legacy flat `anthropic_api_key`, plus a
  config-driven provider-selection runtime.
- **Class-based LLM whitelisting in agent manifests**: agents declare
  `permissions.llm.models_allowed` with provider-agnostic class refs
  (`class:fast|balanced|frontier`); the runtime gate resolves them against the
  active provider. Concrete vendor ids and `*`-wildcards still work (back-compat).
- **Provider-aware `ctx.llm` with per-plugin pinning**: each plugin's host-LLM
  runs on its assigned provider (per-plugin pin → global default → Anthropic),
  resolved consistently for both the whitelist gate and execution. The Anthropic
  default path is byte-identical.
- **Provider admin**: `GET/POST /api/v1/admin/providers` (connection status,
  per-agent provider+model assignment) and a `/admin/providers` operator page
  with an AVV / data-flow disclosure (DSGVO Art. 28) on non-Anthropic selection.
- **Usage telemetry**: OpenAI model pricing tables with provider-aware,
  double-count-safe cost computation (OpenAI cached-input semantics differ from
  Anthropic's).
- `@omadia/orchestrator`: migrated the orchestrator and local-sub-agent LLM
  boundary off direct `@anthropic-ai/sdk` calls onto the neutral
  `@omadia/llm-provider` seam. Internal loops still build Anthropic-shaped
  params and read Anthropic-shaped responses; only the boundary call path now
  translates through `llmProviderSeam`, including streaming final-event usage
  telemetry and provider-based retry classification.

### Fixed

- **web-ui/chat**: provider errors (quota, rate-limit, billing) are now surfaced
  as the provider's human-readable sentence across all chat surfaces — the main
  chat bubble, the builder chat, the preview chat, and the default simple
  builder intake — with a translated generic fallback, instead of the raw HTTP
  status and JSON envelope. On the primary path the orchestrator failure arrives
  as an in-band error event on an already-streaming 200 response; the background
  stream toast now finishes that turn as a failure showing the same humanized
  sentence, instead of reporting it as 'done' (a successful turn) as it did
  before (#403).

---

## [0.54.0] - 2026-07-06

### Added

- **web-ui/chat**: collapsible debug-chat intro banner (#428)

---

## [0.53.0] - 2026-07-06

### Added

- **web-ui**: restore Days One face for the omadia wordmark (#427)

---

## [0.52.3] - 2026-07-06

### Fixed

- **channels**: rebind inbound route handler on hot-reinstall (#395) (#407)

---

## [0.52.2] - 2026-07-06

### Changed

- move Orchestrators/Conductor into Admin cluster, enlarge chevron (#424)

### Fixed

- **web-ui**: stop chat auto-scroll from yanking user back to bottom (#404) (#425)

---

## [0.52.1] - 2026-07-06

### Fixed

- **web-ui**: allow changing or removing an LLM provider's API key (#402) (#423)

---

## [0.52.0] - 2026-07-03

### Added

- **builder**: wire type:oauth UI + gate provider/scopes
- **builder**: add oauth_providers descriptor + type:oauth wiring for AgentSpec (#371)

---

## [0.51.0] - 2026-07-03

### Added

- **skills**: skill lifecycle — import, edit, safety guard, multi-source adapters, bundles, and direct-answer persona skills (#411)

---

## [0.50.1] - 2026-07-03

### Fixed

- **store**: portal install drawer above global header

---

## [0.50.0] - 2026-07-02

### Added

- **orchestrator**: per-Agent LLM model selection

### Fixed

- **orchestrator**: address per-Agent model selection review

---

## [0.49.0] - 2026-07-02

### Added

- **ui-prefs**: persist Lume palette/appearance server-side per user (#287)

### Fixed

- **ui-prefs**: avoid 401 bounce; clear prefs cookie on logout

---

## [0.48.0] - 2026-07-01

### Added

- **store**: dynamic post-install setup options for plugin fields (#393)

---

## [0.47.0] - 2026-07-01

### Added

- **conductor**: guided designer UX — dropdowns + builders replace raw ISO/cron/JSON inputs (#398)

---

## [0.46.1] - 2026-06-30

### Fixed

- **ui**: update table rendering behavior (#366)

---

## [0.46.0] - 2026-06-30

### Added

- **conductor**: approval-card reminder contract + holder-authorized await resolution (#394)

---

## [0.45.0] - 2026-06-30

### Added

- **conductor**: principalRef identity-bridge for channel-binding delivery (P2a) (#389)

---

## [0.44.0] - 2026-06-30

### Added

- Omadia Conductor — deterministic workflow engine (Spec 005, US1–US9 + waves 1–6 + channel event-emit) (#388)

---

## [0.43.1] - 2026-06-29

### Fixed

- implement pr feedback
- **ui**: update dropdown font + bg color

---

## [0.43.0] - 2026-06-29

### Added

- **platform**: plugin egress primitives — ctx.net (raw TCP) + $config.* in network.outbound (#370)

---

## [0.42.0] - 2026-06-29

### Added

- implement pr feedback

### Fixed

- **auth**: redirect /login to dashboard if already logged in

---

## [0.41.0] - 2026-06-24

### Added

- **#309**: run agents on LLM subscriptions via the official CLIs (#367)

---

## [0.40.0] - 2026-06-24

### Added

- in-app "Create Issue" button (operator GitHub device flow) (#363)

---

## [0.39.0] - 2026-06-23

### Added

- **builder**: run codegen + preview on any configured LLM provider (#297) (#320)

---

## [0.38.0] - 2026-06-22

### Added

- **platform**: declarative kernel OAuth broker (descriptor engine) — spec 005 core (#325)

---

## [0.37.3] - 2026-06-22

### Fixed

- **web-ui**: lowercase the omadia brand name in user-facing text (#359)

---

## [0.37.2] - 2026-06-22

### Fixed

- **desktop**: rename wizard bridge const to avoid global name collision (#358)

---

## [0.37.1] - 2026-06-22

### Fixed

- **desktop**: bundle preload so the onboarding wizard works (+ install verbosity) (#357)

---

## [0.37.0] - 2026-06-22

### Added

- **desktop**: native one-click installer with bundled PostgreSQL 17 + pgvector (macOS/Linux/Windows) (#355)

---

## [0.36.0] - 2026-06-19

### Added

- **desktop**: native one-click installer (Electron + embedded PGlite) + signing CI (#341)

---

## [0.35.1] - 2026-06-19

### Fixed

- **ci**: publish versioned + latest images on auto-release (#340)

---

## [0.35.0] - 2026-06-19

### Added

- minimal-core onboarding stack (prebuilt images + opt-in overlays) (#339)

---

## [0.34.0] - 2026-06-18

### Added

- **orchestrator**: agent transparency + Direct Line + forced delegation (#332) (#335)

---

## [0.33.2] - 2026-06-18

### Fixed

- **builder**: persist preview test-credentials on apply + host-backed preview ctx.llm (#334)

---

## [0.33.1] - 2026-06-18

### Fixed

- **builder**: provide ctx.jobs + ctx.status stubs in preview harness (#328)

---

## [0.33.0] - 2026-06-17

### Added

- **privacy-guard**: render V4 results as a structured, guard-flagged canvas table (#324)

---

## [0.32.0] - 2026-06-17

### Added

- **llm**: contract-only SDK-free core + wire-format adapter packages (#298) (#323)

---

## [0.31.0] - 2026-06-16

### Added

- **kg**: automatic self-curation — durable coverage grows + duplicates auto-merge (#322)

---

## [0.30.0] - 2026-06-16

### Added

- **platform**: runtime credentials + flow toolkit + plugin status (spec 004) (#318)

---

## [0.29.0] - 2026-06-16

### Added

- Lumens (Live Interactivity) 1.1 — canvas-core + Tier-2 producer (server) (#315)

---

## [0.28.0] - 2026-06-16

### Added

- **orchestrator**: durable long-term knowledge tier + auto-promotion (#317)

---

## [0.27.1] - 2026-06-16

### Fixed

- **web-ui**: widen markdown table cell spacing to Lume density (#316)

---

## [0.27.0] - 2026-06-15

### Added

- **orchestrator-extras**: relevance-gate + LLM-agnostic judge for cross-session recall (#310)

---

## [0.26.0] - 2026-06-15

### Added

- **llm-provider**: support keyless local providers (e.g. Ollama) (#308)

---

## [0.25.2] - 2026-06-15

### Fixed

- **ui-orchestrator**: canvas composition uses model classes + mirror provider keys (fixes stuck "Working on it…") (#307)

---

## [0.25.1] - 2026-06-15

### Fixed

- **llm**: register provider plugins on hot-install, not just at boot (#306)

---

## [0.25.0] - 2026-06-15

### Added

- **install**: multiline setup fields for string/secret values (#305)

---

## [0.24.1] - 2026-06-15

### Fixed

- **llm**: preserve server tools through the provider seam (live 400 hotfix) (#304)

---

## [0.24.0] - 2026-06-15

### Added

- **pairing**: friction-free Omadia UI ↔ host pairing — server side (#293) (#303)

---

## [0.23.0] - 2026-06-15

### Added

- **admin**: data-driven provider compliance flags (requiresAvvDisclosure/euHosted) (#302)

---

## [0.22.0] - 2026-06-15

### Added

- **llm**: everything-is-a-plugin — pluggable provider seam + empty core (Anthropic/OpenAI/Mistral/MiniMax plugins) (#300)

---

## [0.21.0] - 2026-06-14

### Added

- **llm**: Mistral as a first-class admin-selectable provider (#299)

---

## [0.20.0] - 2026-06-14

### Added

- **llm**: pluggable LLM provider — OpenAI (GPT-5.x) as admin-selectable provider (#292)

---

## [0.19.0] - 2026-06-14

### Added

- **canvas**: publish privacy-shield datasets — canvas_publish_rows accepts datasetId

### Fixed

- **canvas**: carry the sentinel sink through the STREAMING turn scope too
- **canvas**: carry the sentinel sink into the turn scope — the tap never fired
- **canvas**: tap raw sentinels before privacy interning — guarded servers never rendered

---

## [0.18.0] - 2026-06-12

### Added

- **omadia-ui**: Tier-2 canvas pipeline — skeleton fix, producer tools (rows/charts/choice), typed UI actions, per-user canvas registry (#277)

---

## [0.17.1] - 2026-06-12

### Fixed

- **builder**: resolve Anthropic client per turn so vault-seeded keys reach the Builder (#281)

---

## [0.17.0] - 2026-06-10

### Added

- **builder**: one-click agent export from dashboard cards (#270) (#279)

---

## [0.16.2] - 2026-06-10

### Changed

- **plan-runner**: reuse stored processes + batch plan-step reads, cache overlay (#276)

### Fixed

- **memory**: stop logging expected memory-tool errors as crashes (#278)

---

## [0.16.1] - 2026-06-10

### Fixed

- **builder-preview**: wire ctx.http into the preview runtime (#275)

---

## [0.16.0] - 2026-06-09

### Added

- **ui-orchestrator**: skeleton composition + requirement handoff (#273)

---

## [0.15.0] - 2026-06-09

### Added

- **ui-channel**: thread localOperations + turn action into metadata (#272)

---

## [0.14.0] - 2026-06-08

### Added

- **admin**: de-duplicate per-plugin settings out of the .env admin page (#265)

---

## [0.13.2] - 2026-06-08

### Fixed

- **agent-builder**: propagate runtime agent installs to fallback even when boot was chat-disabled (#266)

---

## [0.13.1] - 2026-06-08

### Fixed

- **orchestrator**: forward modelRouting to per-Agent orchestrators (#263)

---

## [0.13.0] - 2026-06-08

### Added

- **chat**: show the Haiku-triage decision inline in the turn card (#261)

---

## [0.12.1] - 2026-06-08

### Fixed

- **web-ui**: dismiss stream toasts visually + explicit abort with confirm (#260)

---

## [0.12.0] - 2026-06-08

### Added

- **admin**: .env-based settings overview with live auto-apply + model-routing env wiring (#259)

---

## [0.11.1] - 2026-06-07

### Fixed

- **web-ui**: usage dashboard 404 + show per-turn model & tokens in chat (#258)

---

## [0.11.0] - 2026-06-07

### Added

- **plugins**: auto-author self-extension + standalone-plugin SDK (#255)

---

## [0.10.0] - 2026-06-07

### Added

- LLM cost telemetry, dashboard & per-turn Sonnet/Opus routing (#253)

---

## [0.9.0] - 2026-06-07

### Added

- **routines**: cold-start delivery-target model for proactive 1:1 outreach (#252)

---

## [0.8.2] - 2026-06-07

### Fixed

- **middleware**: propagate runtime plugin (de)activation to per-Agent orchestrators (#257)

---

## [0.8.1] - 2026-06-07

### Fixed

- **dynamic-runtime**: late-resolve vault-armed Anthropic client for sub-agents (#256)

---

## [0.8.0] - 2026-06-07

### Added

- **plugins**: operator-gated, non-escalating plugin self-extension (#254)

---

## [0.7.0] - 2026-06-07

### Added

- **plan-runner**: GC semantically-duplicate plans on materialise (#241)

---

## [0.6.1] - 2026-06-06

### Fixed

- **orchestrator**: raise tool-loop cap 25→100 with round-loop guard + best-effort finalize (#240)

---

## [0.6.0] - 2026-06-06

### Added

- **orchestrator**: live mid-turn steering of a running chat turn (#239)

---

## [0.5.2] - 2026-06-06

### Fixed

- **orchestrator**: raise tool-loop cap 12→25 with floor on stale configs (#237)

---

## [0.5.1] - 2026-06-06

### Fixed

- **config**: treat empty optional diagram/S3 env vars as unset, not a boot-crash (#238)

---

## [0.5.0] - 2026-06-06

### Added

- **ui-orchestrator**: Tier-2 surface synthesis in canvasChatAgent (PR-9b-1) (#235)

---

## [0.4.0] - 2026-06-06

### Added

- **builder**: codegen/build/runtime observability tools for the Builder agent (#227) (#236)

---

## [0.3.8] - 2026-06-05

### Fixed

- **middleware**: arm host-LLM plugins on vault key-entry so plan-runner works on fresh installs (#234)

---

## [0.3.7] - 2026-06-05

### Fixed

- **builder**: author plugins from spec.author, not hardcoded "byte5 GmbH" (#225) (#233)

---

## [0.3.6] - 2026-06-05

### Fixed

- **builder**: prevent message loss when toggling simple/extended view (#224) (#231)

---

## [0.3.5] - 2026-06-05

### Fixed

- **web-ui**: install drawer overlays render above global header (#232)

---

## [0.3.4] - 2026-06-05

### Fixed

- **web-ui**: survive stale/foreign chat-session shapes instead of a blank crash (#230)

---

## [0.3.3] - 2026-06-05

### Fixed

- **builder**: raise report_platform_issue summary cap 280→500 (#229)

---

## [0.3.2] - 2026-06-05

### Fixed

- **orchestrator**: boot gracefully without ANTHROPIC_API_KEY (Setup-Wizard key entry) (#228)

---

## [0.3.1] - 2026-06-05

### Fixed

- **knowledge-graph**: survive first-boot Postgres race instead of crash-looping (#226)

---

## [0.3.0] - 2026-06-05

### Added

- **builder**: native core-bug reporting — GitHub App direct-create + UI (#223)

---

## [0.2.1] - 2026-06-05

### Changed

- **builder**: user-facing 'Veröffentlichen' → 'Bereitstellen' (i18n de, redo of #208) (#217)

### Fixed

- **ci**: set git identity before annotated release tag (#218)
- **builder**: ctx.memory in preview runtime, accessor permission lint, and setup_fields rename (#207)

---

## [0.2.0] — 2026-06-05

Second public release of omadia — *An Agentic OS*. 155 commits since v0.1.0.
Headline work: a multi-orchestrator runtime, the omadia UI canvas channel with a
WebSocket transport, a plugin store with remote registries, a major builder
upgrade (persona / quality / audit), the answer verifier, operator-owned Privacy
Mode, and headless Office generation. Pre-1.0: schemas and internal surfaces may
still change between minor versions.

### Added

- **Multi-orchestrator runtime** (US1–US9): run multiple orchestrators with
  strict per-orchestrator memory + Knowledge-Graph isolation, per-channel
  `dispatch_service` routing, and per-binding agent routing with `channelType`
  autodiscovery.
- **omadia UI canvas channel**: an additive canvas interface surface on the
  channel SDK, a WebSocket transport for channel plugins (handshake + turn +
  surface fan-out), canvas sentinel parsers with a canvas-output gate, and
  skeleton `ui-channel` / `ui-orchestrator` plugins.
- **Plugin store (MVP)**: admin-managed remote registries, remote install with
  `depends_on` chaining, and update detection with store-card update prompts.
- **Builder upgrades**: service-type auto-discovery for integration-backed
  agents, preview that reads through to the live `ServiceRegistry`, persona
  templates + gallery (6 archetypes), a quality-score engine + panel, a
  live compiled system-prompt preview, culture presets (6 industry overlays),
  an audit-log backend + timeline UI, a `read_slot` tool, and plan-as-data
  foundations.
- **Answer verifier**: tool-output postcondition validation with retry,
  citation enforcement for Knowledge-Graph-grounded answers, and
  confidence-gated re-sampling on borderline verdicts.
- **Privacy**: operator-owned per-plugin Privacy Mode and stable-id
  tokenization for the privacy-guard proxy.
- **Headless Office**: deterministic `.xlsx` / `.docx` generation with
  multi-channel delivery.
- **Cross-session memory**: a Knowledge-Graph recall probe for plans, processes
  and team insights, with relevance-filtered cross-session plan recall.
- **Knowledge-Graph ACL + curated-memory** system.
- **Setup wizard collects the LLM key** (OB-61): the Anthropic API key is now
  gathered through the first-user setup wizard and stored encrypted in the
  per-plugin vault — `ANTHROPIC_API_KEY` in the environment is no longer
  required.
- **plugin-api**: structured-output + `writeCapabilities` contract, and
  `EntityRef.op` widened to `'read' | 'write'`.
- Localized third-party setup guides (`setup.guide`).
- Architecture Decision Records under `docs/adr`.
- Native issue-reporting + workaround-tracking for the agent builder.
  When the builder hits a platform-side failure (forbidden-import
  gate on valid code, codegen-internal error, core-stack-frame
  crash, admin-route schema violation), it now offers the operator
  a smart card with three options: report + workaround, report +
  pause, or skip. Reports go through a browser-submit flow against
  `byte5ai/omadia` so the operator owns the GitHub attribution; the
  middleware never sees a PAT in v1. A 64 KB sanitizer strips
  AWS keys / GitHub PATs / Slack tokens / IBANs / emails / internal
  URLs before the operator confirms. Per-operator rate limit of 3
  platform reports per 24 h, deduplication via a stable
  fingerprint hash + GitHub search, ETag-aware status cache with
  rate-limit backoff, pause-on-issue with operator-triggered
  resume. Workaround lifecycle state survives re-installs in the
  new `agent_workaround_state` table; identity (issue ref +
  fingerprint + summary) lives on the spec so the manifest carries
  it through to installed agents.
- RFC `docs/cross-channel-memory.md` proposing two new core capabilities,
  `platformIdentity@1` and `crossChannelConversationMemory@1`, plus four
  provider plugins (Neon + in-memory siblings per capability). Driven by
  the omadia-ui Tier-2 orchestrator's hard dependency on
  `crossChannelConversationMemory@1` and the "Telegram → desktop"
  continuity scenario. Additive against `harness-channel-sdk`: the
  existing `ConversationHistoryStore` contract stays unchanged; a new
  `DurableConversationHistoryStore` adapter bridges to the capability
  and falls back to in-memory behavior when the capability is not
  installed. The RFC also specifies a small additive extension to
  `TurnContextValue` in `harness-orchestrator` (`tenantId?`,
  `originatorUserRef?`, `originatorUserId?`, `canvasSessionId?`),
  which lands with PR 4 and absorbs the Phase-12 `tenantId` work from
  `docs/middleware-agent-handoff.md`. The RFC went through three
  Codex-style review rounds before landing: service-registry-key form,
  `TurnContextValue` field availability, the dual `ConversationTurn`
  shape in the SDK, misuse of `ctx.notifications` as an ops/audit
  surface, identity-merge race-safety, outbox idempotency via
  `client_message_id`, structured `CcmAppendError` failure taxonomy,
  audit-event PII minimization plus retention, and the absence of a
  `permissions.routes` manifest key were all fixed against the real
  code in `middleware/packages/` before merge. PR sequence and
  consumer mechanics are spelled out in §15 of the RFC;
  `docs/middleware-agent-handoff.md` §13 gains a Phase 13 roadmap
  entry pointing at the RFC.
- byte5ai engineering-standards applied to the repo
  (`status: applied` in `.github/engineering-standards.yml`):
  - `.hooks/pre-push` blocks direct pushes to `main`/`master` locally.
  - `script/setup` activates the hook and runs the npm bootstrap in one step.
  - AGENTS.md gained a "Git Workflow & Engineering Standards" section.
  - CONTRIBUTING.md documents the pre-push guard and forbids
    `Co-Authored-By:` trailers for AI agents.
  - Server-side branch protection on `main`: pull request required,
    force-push and deletion blocked, all five CI workflow contexts wired
    up as required status checks.
- GitHub Actions re-enabled after the 2026-05-11 outage; first
  post-reactivation runs landed green on the same day.

### Changed

- Public-facing text now brands the product as **omadia** (formerly "Harness").
- Default orchestrator model set to `claude-opus-4-7` (a stale id previously
  caused 404s).
- web-ui: `middleware.ts` renamed to `proxy.ts` for Next.js 16 compatibility.
- `docs/CHANGELOG.md` reformatted to follow the Keep-a-Changelog convention.
  Detailed operational history prior to v0.1.0 is preserved in the git log.
- Replaced the internal `docs/security-migration-plan.md` post-mortem with
  `docs/security-architecture.md`, which describes the generic patterns
  (proxy-over-direct calls, secrets in a vault, scope-locked sub-agent tools)
  without incident-specific identifiers.
- Sanitised `middleware/packages/harness-diagrams` package metadata to remove
  internal hostnames and branding.

### Fixed

- Orchestrator resilience: retry on mid-stream Anthropic `overloaded_error`,
  explicit `maxRetries=5` with turn-failure logging, quarantine of uninstalled
  plugins instead of aborting registry boot, and per-Agent domain tools scoped
  to enabled plugins only.
- Privacy: hardened outbound payloads against lone UTF-16 surrogates; the
  privacy-guard now renders real names instead of apologising, and expands
  "summary + detail" tool results into per-record rows.
- Builder: AST-writes `network.outbound` so integration-backed agents build,
  unblocked non-search plugin specs, scoped plugin ids work end-to-end, and
  new agents emit the `@omadia/agent-*` namespace.
- web-ui: visible session-expiry handling (warning + auto-logout), the plugin
  install drawer is scrollable for long config forms, and the React-Compiler
  warnings were cleared.
- CI pipeline brought back to green after the Actions outage:
  - `actions/setup-node` bumped from `20` to `22` to match
    `middleware/package.json` `engines.node ">=22 <23"`.
  - `schema (migrations on pgvector)` job moved from a stale hardcoded
    list to a glob over five migration domains; coverage went from 9 to
    20 migrations and is now self-updating.
  - `sharp` linux-x64 native binary installed explicitly so the diagram
    test suite can load on CI runners.
  - `middleware/src/index.ts` `prefer-const` false-positive on an
    intentional forward reference suppressed with a documented disable.
- Middleware test suite cleared of stale workshop-vs-public drift: back
  to 2168 passing / 0 failing (7 tests carry `it.skip()` with TODO
  comments documenting root cause — tracked separately for follow-up
  if/when operationally relevant).

---

## [0.1.0] — 2026-05-11

Initial public release of Omadia — *An Agentic OS*.

### Added

- Middleware kernel with plugin runtime, capability registry, and
  scope-locked sub-agent tools.
- Web UI (`web-ui/`) for operator onboarding, plugin install via ZIP upload,
  and chat sessions.
- Reference plugins: `harness-diagrams`, `harness-memory`, and the
  `agent-reference-maximum` / `agent-seo-analyst` boilerplates.
- Docker Compose deployment recipe.
- AGENTS.md + four-file documentation set
  (`docs/README.md`, `docs/middleware-agent-handoff.md`,
  `docs/CHANGELOG.md`, `docs/security-architecture.md`).

### Notes

- Licence: MIT.
- The full pre-release development history is preserved in the maintainer's
  internal repository and is not part of the public git history.

[Unreleased]: https://github.com/byte5ai/omadia/compare/v0.54.0...HEAD
[0.54.0]: https://github.com/byte5ai/omadia/compare/v0.53.0...v0.54.0
[0.53.0]: https://github.com/byte5ai/omadia/compare/v0.52.3...v0.53.0
[0.52.3]: https://github.com/byte5ai/omadia/compare/v0.52.2...v0.52.3
[0.52.2]: https://github.com/byte5ai/omadia/compare/v0.52.1...v0.52.2
[0.52.1]: https://github.com/byte5ai/omadia/compare/v0.52.0...v0.52.1
[0.52.0]: https://github.com/byte5ai/omadia/compare/v0.51.0...v0.52.0
[0.51.0]: https://github.com/byte5ai/omadia/compare/v0.50.1...v0.51.0
[0.50.1]: https://github.com/byte5ai/omadia/compare/v0.50.0...v0.50.1
[0.50.0]: https://github.com/byte5ai/omadia/compare/v0.49.0...v0.50.0
[0.49.0]: https://github.com/byte5ai/omadia/compare/v0.48.0...v0.49.0
[0.48.0]: https://github.com/byte5ai/omadia/compare/v0.47.0...v0.48.0
[0.47.0]: https://github.com/byte5ai/omadia/compare/v0.46.1...v0.47.0
[0.46.1]: https://github.com/byte5ai/omadia/compare/v0.46.0...v0.46.1
[0.46.0]: https://github.com/byte5ai/omadia/compare/v0.45.0...v0.46.0
[0.45.0]: https://github.com/byte5ai/omadia/compare/v0.44.0...v0.45.0
[0.44.0]: https://github.com/byte5ai/omadia/compare/v0.43.1...v0.44.0
[0.43.1]: https://github.com/byte5ai/omadia/compare/v0.43.0...v0.43.1
[0.43.0]: https://github.com/byte5ai/omadia/compare/v0.42.0...v0.43.0
[0.42.0]: https://github.com/byte5ai/omadia/compare/v0.41.0...v0.42.0
[0.41.0]: https://github.com/byte5ai/omadia/compare/v0.40.0...v0.41.0
[0.40.0]: https://github.com/byte5ai/omadia/compare/v0.39.0...v0.40.0
[0.39.0]: https://github.com/byte5ai/omadia/compare/v0.38.0...v0.39.0
[0.38.0]: https://github.com/byte5ai/omadia/compare/v0.37.3...v0.38.0
[0.37.3]: https://github.com/byte5ai/omadia/compare/v0.37.2...v0.37.3
[0.37.2]: https://github.com/byte5ai/omadia/compare/v0.37.1...v0.37.2
[0.37.1]: https://github.com/byte5ai/omadia/compare/v0.37.0...v0.37.1
[0.37.0]: https://github.com/byte5ai/omadia/compare/v0.36.0...v0.37.0
[0.36.0]: https://github.com/byte5ai/omadia/compare/v0.35.1...v0.36.0
[0.35.1]: https://github.com/byte5ai/omadia/compare/v0.35.0...v0.35.1
[0.35.0]: https://github.com/byte5ai/omadia/compare/v0.34.0...v0.35.0
[0.34.0]: https://github.com/byte5ai/omadia/compare/v0.33.2...v0.34.0
[0.33.2]: https://github.com/byte5ai/omadia/compare/v0.33.1...v0.33.2
[0.33.1]: https://github.com/byte5ai/omadia/compare/v0.33.0...v0.33.1
[0.33.0]: https://github.com/byte5ai/omadia/compare/v0.32.0...v0.33.0
[0.32.0]: https://github.com/byte5ai/omadia/compare/v0.31.0...v0.32.0
[0.31.0]: https://github.com/byte5ai/omadia/compare/v0.30.0...v0.31.0
[0.30.0]: https://github.com/byte5ai/omadia/compare/v0.29.0...v0.30.0
[0.29.0]: https://github.com/byte5ai/omadia/compare/v0.28.0...v0.29.0
[0.28.0]: https://github.com/byte5ai/omadia/compare/v0.27.1...v0.28.0
[0.27.1]: https://github.com/byte5ai/omadia/compare/v0.27.0...v0.27.1
[0.27.0]: https://github.com/byte5ai/omadia/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/byte5ai/omadia/compare/v0.25.2...v0.26.0
[0.25.2]: https://github.com/byte5ai/omadia/compare/v0.25.1...v0.25.2
[0.25.1]: https://github.com/byte5ai/omadia/compare/v0.25.0...v0.25.1
[0.25.0]: https://github.com/byte5ai/omadia/compare/v0.24.1...v0.25.0
[0.24.1]: https://github.com/byte5ai/omadia/compare/v0.24.0...v0.24.1
[0.24.0]: https://github.com/byte5ai/omadia/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/byte5ai/omadia/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/byte5ai/omadia/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/byte5ai/omadia/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/byte5ai/omadia/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/byte5ai/omadia/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/byte5ai/omadia/compare/v0.17.1...v0.18.0
[0.17.1]: https://github.com/byte5ai/omadia/compare/v0.17.0...v0.17.1
[0.17.0]: https://github.com/byte5ai/omadia/compare/v0.16.2...v0.17.0
[0.16.2]: https://github.com/byte5ai/omadia/compare/v0.16.1...v0.16.2
[0.16.1]: https://github.com/byte5ai/omadia/compare/v0.16.0...v0.16.1
[0.16.0]: https://github.com/byte5ai/omadia/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/byte5ai/omadia/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/byte5ai/omadia/compare/v0.13.2...v0.14.0
[0.13.2]: https://github.com/byte5ai/omadia/compare/v0.13.1...v0.13.2
[0.13.1]: https://github.com/byte5ai/omadia/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/byte5ai/omadia/compare/v0.12.1...v0.13.0
[0.12.1]: https://github.com/byte5ai/omadia/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/byte5ai/omadia/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/byte5ai/omadia/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/byte5ai/omadia/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/byte5ai/omadia/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/byte5ai/omadia/compare/v0.8.2...v0.9.0
[0.8.2]: https://github.com/byte5ai/omadia/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/byte5ai/omadia/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/byte5ai/omadia/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/byte5ai/omadia/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/byte5ai/omadia/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/byte5ai/omadia/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/byte5ai/omadia/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/byte5ai/omadia/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/byte5ai/omadia/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/byte5ai/omadia/compare/v0.3.8...v0.4.0
[0.3.8]: https://github.com/byte5ai/omadia/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/byte5ai/omadia/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/byte5ai/omadia/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/byte5ai/omadia/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/byte5ai/omadia/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/byte5ai/omadia/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/byte5ai/omadia/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/byte5ai/omadia/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/byte5ai/omadia/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/byte5ai/omadia/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/byte5ai/omadia/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/byte5ai/omadia/releases/tag/v0.1.0
