# 0162 — The session scope has a typed form, `ScopeId`; the wire string does not move

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); design in
  `specs/575-scope-and-identity-foundation/spec.md` (issue #575, decisions D1–D3, D7),
  implemented in #713 (`ScopeId`) and #714 (`unsharedConversationScope`)
- **Supersedes:** —

## Context and Problem Statement

A turn's `sessionScope` is a bare string. It keys conversation history, the knowledge-graph
partition, parked MCP input and, since the audience floor, attachment bindings. The spec
measured its producers: five separator conventions (`http-…`, `teams-…`, `a::b`,
`routine:…`, a bare session id) and two literals that many unrelated callers share,
`'http-default'` and `'teams-unknown'`. The second kind was the cross-user hole of #445,
held shut by a denylist. This record is retroactive. How does the kernel reason about a scope
without moving a single stored partition?

## Decision Drivers

- A consumer must not treat a shared bucket as a room by accident.
- Machine runs (routines, schedules, Conductor) have no audience at all.
- Changing a scope string changes its graph partition and orphans that conversation's memory.
- `sessionScope?: string` is a published channel-SDK contract (`ChatTurnInput`), consumed by
  channel plugins in other repositories.

## Considered Options

- **A — A typed union inside the kernel, parsed from and formatted back to the unchanged
  wire string.**
- **B — Change the published contract to a structured scope.**
- **C — Keep strings and maintain denylists** (`SHARED_SCOPES`, `SYNTHETIC_SCOPE_PREFIXES`).
- **D — Adopt the union proposed in #575 unchanged** (`personal`, `channel`, `group`, `team`,
  `org`).

## Decision Outcome

Chosen option: **A**, in `middleware/packages/harness-channel-sdk/src/scopeId.ts`, exported
from `@omadia/channel-sdk`. Everything in it is pure and synchronous.

- **Six kinds.** `personal`, `conversation` (optional `channelId`), `group`, `org`, `system`
  and `unscoped`. It is `conversation` because "channel" already means the plugin; `team`
  was dropped because nothing constructs it.
- **"No resolvable scope" is a type, not a value.** `unscoped` carries a `reason`: `absent`
  (nothing supplied, cannot be redeemed) or `shared` (a bucket from `SHARED_SCOPE_TOKENS`:
  `'http-default'`, `'teams-unknown'`, `'unknown'`, with the literal kept in `token`).
- **Machine scopes are their own kind.** `system` has an `origin` from
  `SYSTEM_SCOPE_ORIGINS` (`routine`, `schedule`, `conductor`, `conductor-builder`).
- **`isAddressableScope` is the gate.** It is false for `system` and `unscoped`. A consumer
  that needs a room asks it instead of keeping a list of strings.
- **The string stays at the boundary.** `ChatTurnInput.sessionScope` and
  `turnContext.sessionScope` remain `string`; consumers call `parseSessionScope`.
- **`parseSessionScope` is a migration adapter.** It classifies every value the tree produces
  and `formatSessionScope` returns it byte-identically. It does not decode `teams-<id>` or
  `telegram:<id>`; both stay opaque `conversation` scopes, because decoding would re-emit a
  different string.
- **Compare kind and reference as a pair.** A `conversation` scope formats to its bare id,
  which may itself read `personal:x`. `attachmentBinding.ts` and migration `0036` therefore
  store and compare `scope_kind` and `scope_ref` separately.
- **No new shared bucket.** A consumer that meets `unscoped` falls back to a key unique to
  the turn (`unscoped:<turnId>` in `tools/executeTool.ts` and `tools/publishTool.ts`).
  `unsharedConversationScope` does the same for a channel ingress: an unscoped result becomes
  `unresolved-<suffix>`, keyed on the platform's message id or a random UUID.
- **Injective graph key, opt-in.** `scopeGraphKey` keeps an already safe scope
  byte-identical and adds a 16-hex SHA-256 digest of the raw string to every other one.
  `graphScopeFor` (`sessionLogger.ts`) uses it only when `OMADIA_INJECTIVE_SCOPE_KEYS=1`;
  the default is still the lossy `sanitizeScope`.

Not done on main, and not claimed by this record:

- The graph key is not injective by default. Switching it orphans every partition whose
  scope was lossy (`teams-<conv>`, `telegram:<id>`, `routine:<id>`, `a::b`); the code
  comment leaves that migration to a later step.
- Producers still spell scopes their own way; `routes/chat.ts` still returns
  `'http-default'`. `unsharedConversationScope` has no caller in this repository; whether
  the channel plugins in their own repositories call it was not checked here (spec D7).
- `scopeAncestors` and `resolvePostureFor` (spec §7) do not exist; postures are not resolved
  per `ScopeId` (ADR-0107).
- No turn ingress produces `personal`, `group` or `org`. They are owner scopes of skills
  (ADR-0068), and `tools/publishAccess.ts` reads `personal`.
- The first consumer named in the spec, `directLineSticky.ts`, dropped its two denylists in
  #713 and was removed with Direct Line in #2139 (ADR-0012). The spec file still carries its
  Phase-0 header "DRAFT … implements nothing".

### Consequences

- 🟢 **Good:** The #445 class of bug is visible in the type: binding an attachment to
  `'http-default'` is refused by `isAddressableScope`, not by a list someone has to extend.
- 🟢 **Good:** No stored scope string and no existing partition moved.
- 🔴 **Bad:** The type is advisory at the boundary. A producer can still hand over any
  string, and a new shared literal that is not in the set parses as a `conversation`.
- 🔴 **Bad:** With the default graph key, `teams::c1`, `teams:c1` and `teams-c1` still share
  one graph partition, as do scopes that differ only in case or beyond 80 characters.
- 🔴 **Bad:** `formatSessionScope` is not injective across kinds; every store that persists
  a scope has to keep the kind beside it.
- ⚪ **Neutral:** `memoryContextKey` in the same file is the partition key of context
  memory, built the same way; its rules are in ADR-0116 and ADR-0145.

## Pros and Cons of the Options

### A — Typed inside, string outside

- 🟢 Additive; no plugin breaks, no partition moves.
- 🔴 Two representations, and the adapter has to stay conservative.

### B — Structured scope in the published contract

- 🔴 Breaks channel plugins across repository boundaries with no compiler to catch it
  (spec §4, item 6, decision D2).

### C — Strings and denylists

- 🔴 Every new consumer has to know the lists; `'teams-unknown'` had a live producer that an
  earlier revision of the spec had declared dead.

### D — The union from #575 unchanged

- 🔴 Cannot express machine scopes or the absent scope, so both denylists would survive
  under new names (spec §3).

## More Information

- Related: ADR-0110 (`Principal`; #333 produces principals, #575 consumes them), ADR-0145
  (`TurnOrigin` carries a `ScopeId`), ADR-0068, ADR-0073 (dispatch guards, including the
  audience floor of #575 phase 2), ADR-0107, ADR-0116.
- Code: `middleware/packages/harness-channel-sdk/src/scopeId.ts`;
  `middleware/packages/harness-orchestrator/src/attachmentBinding.ts`, `sessionLogger.ts`,
  `tools/executeTool.ts`, `tools/publishTool.ts`, `tools/publishAccess.ts`;
  `middleware/src/services/skillLifecycleStore.ts`, `skillResolver.ts`;
  `middleware/migrations/0036_attachment_scope_bindings.sql`.
- Tests: `middleware/test/scopeId.test.ts` (classification, byte-identical round trip,
  injective graph key), `unsharedConversationScope.test.ts`,
  `sessionLoggerGraphScope.test.ts` (the env switch), `memoryContextKey.test.ts`.
- Spec: `specs/575-scope-and-identity-foundation/spec.md` §2.2, §2.3, §3, §8.
