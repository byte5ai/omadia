# Phase 0 — Scope model (#575) and Identity projection (#333)

> **Status: DRAFT — awaiting sign-off. This document implements nothing.**
> Phase 1 (code) is not authorized until the decisions in §8 are answered.
>
> **Rev 2** — after PR #711 merged, the private plugin repo (`omadia-byte5-plugins`
> @ `7dcce57`) was inspected, which **closed D6 and corrected two findings in Rev 1**: the
> two production channels bypass `CoreApi` and build their own `sessionScope`, and
> `'teams-unknown'` has a live producer. See §2.2. New open item **D7**.

**Measured against `origin/main` @ `e4e892e7`** (OSS tree) **and `omadia-byte5-plugins`
@ `7dcce57`** (private plugins). Every `file:line` in this document was re-read at those
commits; §10 lists what remains unverified.

---

## 1. What this document is

#333 and #575 are both Cx 9 and together touch 60–100+ files. They also touch the **same
seam** (`resolveIdentity`, principal ids, the turn's scope), which is why building either
one blind produces an unreviewable PR that the other has to undo.

This document answers five questions and stops. It is the deliverable of Phase 0.

The trigger is not completeness. **`#579` (sneumannb5, PR #681, 12 files / +1898) is already
in flight against a scope model that does not exist.** §7 measures what it actually needs —
the answer is much smaller than the full model, and it is good news.

---

## 2. The measured ground truth

### 2.1 Three unrelated things are called "scope"

This is the single biggest source of confusion in this cluster and it must be resolved in
naming *before* any code is written.

| | Namespace | What it keys | Type | Defined at |
|---|---|---|---|---|
| **A** | **Session scope** | the turn's partition key — memory recall, graph partition, sticky binding, parked MCP input | `string` (untyped) | `harness-orchestrator/src/turnContext.ts:84` |
| **B** | **Memory scope** | a path-pattern allowlist over the virtual memory tree | `readonly string[]` | `harness-orchestrator/src/registry/scopedMemoryStore.ts` (`orchestratorMemoryScope`) |
| **C** | **Posture "scope"** | *not a scope at all* — a deployment-wide `SecurityPosture` **value** | `'dangerous'\|'auto'\|'strict'` | #579 / PR #681, setup field `security_posture_scope` |

**#575 is about (A) only.** (B) is an orthogonal, already-working mechanism with different
semantics (deny-by-default path patterns) and must not be merged into (A). (C) is a naming
collision that will land on `main` before #575 does — see decision **D5**.

### 2.2 The real value space of `sessionScope` (all producers, measured)

`sessionScope` is a bare `string`. These are every value-producing site in
`middleware/src` + `middleware/packages`:

| Producer | `file:line` | Shape produced |
|---|---|---|
| HTTP chat, explicit `scope` | `routes/chat.ts:52` | `` `http-${scope}` `` |
| HTTP chat, `sessionId` | `routes/chat.ts:53` | bare `sessionId`, `[A-Za-z0-9_-]{1,80}` |
| HTTP chat, anonymous | `routes/chat.ts:54` | **`'http-default'`** — shared by *every* anonymous caller |
| `CoreApi` channel path | `channels/coreApi.ts:80` | `` `${channelId}::${conversationId}` `` |
| **Teams (private plugin)** | `omadia-byte5-plugins` `channel-teams/src/teamsBot.ts:441` | `` `teams-${conversationId}` ``, with `conversationId ?? 'unknown'` at `:440` |
| **Telegram (private plugin)** | `omadia-byte5-plugins` `channel-telegram/src/telegramBot.ts:993` | `` `telegram:${chat.id}` `` |
| Routine run | `plugins/routines/routineRunner.ts:671,707` | `` `routine:${routine.id}` `` |
| Schedule run | `scheduler/scheduleWorker.ts:119` | `` `schedule:${scheduleId}` `` |
| Conductor step | `conductor/realStepEffects.ts:116` | `` `conductor:${runId}:${step.id}` `` |
| Conductor builder | `conductor/builderAgent.ts:189` | `` `conductor-builder:${slug}:${uuid}` `` |
| Orchestrator fallback | `turnContext.ts:84` (doc) | the turn id, when the caller supplied none |

**Five** separator conventions coexist: `-` (`http-…`, `teams-…`), `::` (`CoreApi`), `:`
(machine scopes, `telegram:`), and the bare `sessionId` with no separator at all — the last
being **indistinguishable from a scope kind name** by inspection.

> ### ⚠️ The two production channels bypass `CoreApi` and build their own scope
>
> **This corrects the first published version of this document** (PR #711), which listed
> `channels/coreApi.ts:80` as the producer for "all channels" and reported the
> `directLineSticky` denylist entries as dead. Measured in `~/sources/omadia-byte5-plugins`
> @ `7dcce57`:
>
> - Neither `channel-teams` nor `channel-telegram` calls `coreApi.handleTurnStream` at all
>   (0 hits for `handleTurnStream` / `coreApi.` in either package's `src/`). They construct
>   `sessionScope` themselves. **`${channelId}::${conversationId}` is therefore not the
>   shape real channel traffic carries** — it is the shape the in-tree `CoreApi` path would
>   produce for a channel that used it.
> - **`'teams-unknown'` has a live producer.** `teamsBot.ts:440-441` is
>   `const conversationId = context.activity.conversation?.id ?? 'unknown'` followed by
>   `` const sessionScope = `teams-${conversationId}` ``. When Teams omits a conversation id,
>   the scope is literally `teams-unknown`. **The denylist entry is load-bearing, not dead —
>   it must not be deleted, it must be expressed in the type.**
> - `'unknown'` **bare** still has no observed producer, in either repo.
>
> **This is a second live instance of the `'http-default'` hole, in production Teams**: every
> Teams turn that arrives without a conversation id shares one scope. Today `SHARED_SCOPES`
> is the only thing preventing a sticky binding from leaking across those callers — which is
> precisely why §3(b) makes "no resolvable scope" a *type* rather than a value.

### 2.3 The hardest constraint: the graph key is a *lossy* projection

`sessionScope` does not reach the knowledge graph verbatim. It passes through
`graphScopeFor` → `sanitizeScope` (`harness-orchestrator/src/sessionLogger.ts:219-244`,
`SCOPE_MAX_LEN = 80` at `:45`):

```ts
scope.trim()
  .replace(/[^a-zA-Z0-9_-]+/g, '-')   // ':' and '::' both collapse to '-'
  .replace(/^-+|-+$/g, '')
  .slice(0, 80)                        // truncation
  .toLowerCase()                       // case folding
```

This mapping is **not injective**. Measured consequences:

| These distinct scopes… | …become this one graph key |
|---|---|
| `teams::c1`, `teams:c1`, `teams-c1` | `teams-c1` |
| `personal:alice`, `personal-alice`, `Personal:Alice` | `personal-alice` |
| any two scopes agreeing on their first 80 sanitized chars | that prefix |

Today this is a *recall-quality* nuisance. **The moment scope becomes a security boundary —
which is the entire point of #575 — a non-injective partition key is an isolation
vulnerability**: two scopes that must not see each other's memory can land in one graph
partition, and the isolation check (`excludeScope`, string equality in
`contextRetriever.ts:976,1026,1357,1381`) passes while the data is already shared.

Any `ScopeId` design must state whether the graph key becomes injective, and if not, why
that is safe. This is decision **D3**. It is the one finding in this document I would not
have predicted from the issue text, and it is the reason a `:`-separated `ScopeId` cannot
simply be dropped into the existing pipe.

### 2.4 Identity — what exists, what is absent

#333's own evidence table is accurate; I re-verified it and add four corrections.

| Claim | Verdict | Evidence @ `e4e892e7` |
|---|---|---|
| Auth is provider-based and pluggable | ✅ EXISTS | `auth/providerRegistry.ts:18` (`ProviderRegistry`), `:77` (`ProviderCatalog`) — **authn-only, no attribute/role facet** |
| A platform identity layer | ❌ **ABSENT** | `middleware/src/identity/` does not exist |
| `coreApi.resolveIdentity` is a real join | ⚠️ **v1 passthrough** | `channels/coreApi.ts:111-123` — returns `platformId = \`${ref.kind}:${ref.id}\`` + optional displayName/email. No join, no roles, comment says so. |
| Org roles | ❌ **ABSENT** | `auth/migrations/0001_users.sql:40` — `CHECK (role IN ('admin'))`. **Exactly one role exists.** No MS-Graph groups anywhere. |
| Conductor has the principal model | ✅ EXISTS | `conductor/migrations/0001_conductor.sql:77` `principal_kind IN ('user','role')`; `principalId.ts:11` `canonicalizePrincipalId`; `awaitStore.ts:26` `resolveAwaitHolders` (late-bound) |
| Conductor's role resolver is local | ⚠️ **local, by design-debt** | `conductor/roleStore.ts:37` `resolve()`; the comment at `:22` calls the external resolver "a follow-up" |

**Correction 1 — `resolveIdentity` is an overloaded name covering two unrelated contracts.**
Conflating them will cause a real bug:

- `coreApi.resolveIdentity(ChannelUserRef) → PlatformIdentity` — channel user → platform
  identity (`channels/coreApi.ts:111`). **This is #333's seam.**
- `mcpClient.auth.resolveIdentity(McpServerConfig) → string|null` — the acting identity for
  a `per_user` MCP server's audit trail (`mcp/mcpClient.ts:292`, used at `:1216-1218`, wired
  at `index.ts:2074` and `routes/agentBuilder.ts:296`). **Unrelated. #333 must not touch it.**

**Correction 2 — identity clustering already exists, in the "wrong" package.** #568 / PR
#691 (merged) shipped `resolveTurnOwnerIdentity.ts` in `harness-orchestrator`, which
resolves a channel user → canonical omadia uuid (via
`KnowledgeGraph.resolveOrCreateChannelIdentity`) → the IdP subject of the caller's cluster,
returning `{ omadiaUserId?, authSubjectKey? }`. **That is the working seed of #333's join
layer**, and it lives in the knowledge-graph + orchestrator packages, not in an identity
layer. #333 is therefore less greenfield than the issue implies — it is largely a
*relocation and generalization* of code that already works.

**Correction 3 — the participant seam exists and is real, but is optional and role-free.**
`ChatParticipantsProvider = () => Promise<ChatParticipant[]>`
(`harness-orchestrator/src/chatParticipants.ts:28`), installed per-channel (Telegram
`rosterProvider`, Teams equivalent), reachable via `turnContext.chatParticipants?`. A
`ChatParticipant` (`:9-20`) carries `channelUserId`, `aadObjectId`, `displayName`, `email`,
`userPrincipalName` — i.e. **correlation keys, and no entitlements and no omadia user id**.
Two consequences: (a) it is exactly the input #333's join layer converts into Principals;
(b) it is **`?`-optional — HTTP and web turns have no participant list at all**, so an
audience floor has nothing to intersect there (see §6.1).

**Correction 4 — the flagged blocker `#582` is not one.** The wave prompt lists #582
(Deployment-directory contract, sneumannb5) alongside #579 as "building against the missing
foundation". Measured against the issue body, #582 is about a committed deployment directory,
`qm.config.jsonc`, computed secrets, image-digest pins and an agent-run deploy skill. It
contains **no scope concept**. #579 is the only real dependency in that pair.

---

## 3. Q1 — What does `ScopeId` look like?

Testing #575's proposed union (`personal:` / `channel:` / `group:` / `team:` / `org:`)
against the values measured in §2.2:

| qm form | omadia value that maps to it | Verdict |
|---|---|---|
| `personal:<id>` | *none* — no producer emits a per-person scope today | **NEW** |
| `channel:<ref>` | `` `${channelId}::${conversationId}` `` (CoreApi), `` `teams-${conversationId}` ``, `` `telegram:${chat.id}` `` | maps — but **three** incompatible spellings, see §2.2 |
| — | `'teams-unknown'` (Teams with no conversation id) | ❌ **does not map** — same class as `http-default` |
| `group:<ref>` | *none* | NEW |
| `team:<id>` | *none* | NEW — and undistinguished from `group:` |
| `org:<id>` | *none* | NEW |
| — | `'http-default'` | ❌ **does not map** |
| — | `` `http-${scope}` ``, bare `sessionId` | ❌ do not map |
| — | `routine:` `schedule:` `conductor:` `conductor-builder:` | ❌ do not map |

**The proposed union is incomplete for omadia in two specific ways, and shipping it as-is
would preserve the exact denylist it is meant to delete.**

**(a) Machine scopes are a distinct kind, not a degenerate `personal:`.** `routine:`,
`schedule:`, `conductor:`, `conductor-builder:` have **no audience** — no human is present,
so "the intersection of everyone's rights" is not merely restrictive, it is undefined. They
are also unbounded in number and repeat verbatim across executions. If they are not a
first-class variant, `SYNTHETIC_SCOPE_PREFIXES` survives the refactor under a new name.

**(b) `'http-default'` is not a scope; it is the *absence* of one.** Today it is a value
that every anonymous caller shares — the live cross-user hole documented at
`turnContext.ts:79-83` and `mcp/pendingMcpInput.ts:36`, and the reason #445 needed
`SHARED_SCOPES` at all. In a typed model it must be a variant that is **unresolvable**, so
that every consumer is forced by the compiler to handle it rather than silently sharing a
bucket. *Making this hole a type error is the single highest-value thing #575 Phase 1 does.*

### Recommendation (decision **D1**)

```ts
type ScopeId =
  | { kind: 'personal';     userId: string }
  | { kind: 'conversation'; channelId: string; conversationId: string }
  | { kind: 'group';        groupRef: string }
  | { kind: 'org';          orgId: string }
  | { kind: 'system';       origin: 'routine' | 'schedule' | 'conductor' | 'conductor-builder';
                            id: string }
  | { kind: 'unscoped' };
```

Two deliberate departures from #575's text:

- **`conversation`, not `channel`.** omadia already uses "channel" for the *plugin*
  (Teams/Telegram/API), and `channelId` is a **field inside this very variant**. Reusing the
  word as the variant name guarantees `channel.channelId` confusion in every review.
- **`team` dropped.** No producer, no consumer, and #575 does not say what distinguishes it
  from `group`. Add it when something needs it; a variant nobody constructs is a variant
  nobody maintains.

Serialization is a separate concern from the type — see **D3**, which decides whether the
wire form can keep using `:`.

---

## 4. Q2 — Migration path per `sessionScope` consumer

**107** non-test `sessionScope` occurrences across **23** source files. Grouped by consumer,
with a verdict per entry: *mechanical* (a type change, no semantics) vs *decision* (someone
must choose something).

| # | Consumer | File (occurrences) | What it does with the scope | Verdict |
|---|---|---|---|---|
| 1 | Orchestrator | `harness-orchestrator/src/orchestrator.ts` (44) | canonical threader; computes `graphScopeFor`, feeds retriever + logger | **decision** — the choke point; everything downstream follows its choice |
| 2 | Context retriever | `harness-orchestrator-extras/src/contextRetriever.ts` (17) | graph partition: `getSession(:952)`, `turnNodeId(:573)`, cross-scope exclusion (`:976,1357,1381`), scope-equality filtering (`:951,1026`) | **decision** — *this is where isolation is actually enforced today*, by string equality |
| 3 | HTTP chat route | `src/routes/chat.ts` (10) | `resolveScope` producer | mechanical once D1 lands |
| 4 | Sticky Direct Line | `harness-orchestrator/src/directLineSticky.ts` (5) | the denylists — the thing to delete | mechanical (**this is the Phase-1 proof**) |
| 5 | Session logger | `harness-orchestrator/src/sessionLogger.ts` (3) | `sanitizeScope` / `graphScopeFor` — the lossy projection | **decision — D3** |
| 6 | **Channel SDK (published contract)** | `harness-channel-sdk/src/chatAgent.ts:282`, `channelRouting.ts:74`, `chatAgentService.ts:43` | the plugin-facing `sessionScope?: string` | **decision — BREAKING, see below** |
| 7 | Plan-runner plugin | `harness-plugin-plan-runner/src/plugin.ts` (3) | passthrough | mechanical |
| 8 | Turn hooks | `harness-orchestrator/src/turnHooks.ts` (2), `src/platform/turnHookRegistry.ts` (1) | hook payload | mechanical |
| 9 | Verifier | `harness-orchestrator/src/verifierService.ts` (2), `harness-verifier/src/verifierPipeline.ts` (1) | re-run keying | mechanical |
| 10 | Nudges | `…extras/src/nudgeProviders/processPromote.ts` (2), `plugin-api/src/nudge.ts` (1) | nudge keying | mechanical |
| 11 | Parked MCP input | `harness-orchestrator/src/mcp/pendingMcpInput.ts` (1) | one leg of the `{userId, sessionId, correlationId}` triple | **decision** — security-relevant (#445 hole) |
| 12 | Routines | `src/plugins/routines/routineRunner.ts` (2) | producer `routine:` | mechanical |
| 13 | Scheduler | `src/scheduler/scheduleWorker.ts` (1) | producer `schedule:` | mechanical |
| 14 | Conductor | `src/conductor/realStepEffects.ts` (1), `builderAgent.ts` (2) | producers | mechanical |
| 15 | Channel ingress | `src/channels/coreApi.ts:80`, `orchestratorDispatcher.ts:165` | producer `a::b` | mechanical |
| 16 | Prompt contributions | `src/platform/promptContributionRegistry.ts` (1) | passthrough | mechanical |

**Tally: 6 decisions, ~10 mechanical.** The migration is far more tractable than the raw
file count suggests — but item 6 governs the shape of everything else.

> **Item 6 is the load-bearing one.** `sessionScope?: string` on `ChatAgent` is a
> **published plugin contract**. Changing it breaks the private byte5 channel plugins
> (`harness-channel-teams`, `-telegram`, whose `dist/` is built out of
> `omadia-byte5-plugins`) and any third-party plugin, across a repo boundary, with no
> compiler to catch it here. **Recommendation: keep `string` at the plugin boundary and
> type only internally** — parse at ingress, serialize at egress. This is decision **D2**
> and it is what makes the whole migration additive rather than a major version.

---

## 5. Q3 — How does the audience floor actually bite?

"The intersection of the rights of everyone present" is one sentence and at least three
mechanisms. Four things must be decided before code.

### 5.1 Who counts as "present"? — the seam exists, and it is thinner than the rule needs

`turnContext.chatParticipants?: ChatParticipantsProvider` (§2.4, correction 3). Two hard
limits, both measured:

1. **It is optional.** HTTP and web turns install no provider. An audience floor there has
   an empty participant list — which must mean *"unknown audience"* (fail closed), never
   *"nobody present"* (fail open, intersection of nothing = everything). Getting this
   backwards is a silent full-permission grant.
2. **It carries no entitlements.** `ChatParticipant` has correlation keys only — no roles,
   no omadia user id. **The floor cannot be computed from it without #333's join layer.**
   This is the concrete dependency between the two issues (§6).

### 5.2 Where is it evaluated? — three sites, not one

The single most common way to get this wrong is to plan "the audience floor" as one
function at one place. What it guards has three different correctness requirements:

| What is guarded | Correct evaluation point | Why not per-turn |
|---|---|---|
| **Egress** (allowlist ∩, denylist ∪) | **per tool call** | a turn-start snapshot is a TOCTOU hole — the audience can change before the call fires |
| **Context / memory retrieval** | **per retrieval, per recipient** | the rendered context differs per recipient by definition (`context-filter` in qm) |
| **File / credential handles** | **at handle resolution** | the handle outlives the turn; the check must ride with it |

Recommendation: **specify the floor as three guards sharing one intersection function**, not
as one interception point.

### 5.3 A participant who joins mid-turn — decision **D4**

This is a product decision, not a technical one:

- **(a) Snapshot at turn start.** A joiner sees nothing until the next turn.
- **(b) Re-evaluate per effect.** Correct, expensive, and partly impossible.

Recommendation: **split by reversibility.** Context already rendered cannot be un-sent, so
re-filtering it mid-turn is theatre — snapshot it (a). An outbound call not yet made *can*
be refused — re-evaluate it (b). Any single answer for both is wrong in one direction.

### 5.4 It is the third gate on a path that already has two

Both already intercept every turn:

- **Privacy Shield v4** — `privacyHandle` on `turnContext`, interns every tool result at the
  data-plane boundary.
- **#579 inbound screening** — PR #681 gates every turn ingress.

The audience floor is a *third* gate on the same path. **The spec for Phase 2 must state the
ordering relative to these two**, or three PRs will each add their own interception at a
different point and the composition will be accidental.

---

## 6. Q4 — Where does #333 stop and #575 start?

Both issues touch `resolveIdentity` and the principal id. The boundary must be an invariant,
not a file list, or they will build the same thing twice.

> **#333 answers "who is this, and what are they entitled to?"**
> **#575 answers "given who is present, what may happen in this room?"**
>
> **#333 produces Principals. #575 consumes Principals and produces decisions.**
> **#575 never resolves an identity; #333 never evaluates a permission.**

| Artifact | Owner | Why |
|---|---|---|
| `Principal` (`user:` \| `role:`) | **#333** | half-exists already: `0001_conductor.sql:77`, `principalId.ts:11` |
| Identity join / cluster resolution | **#333** | seed exists: `resolveTurnOwnerIdentity.ts`, `resolveOrCreateChannelIdentity` |
| Role / attribute source registry (Entra groups, Odoo HR) | **#333** | the generalization of `ProviderRegistry` (`providerRegistry.ts:18`) |
| Conductor's `RoleResolver` becoming external | **#333** | `roleStore.ts:22` already calls it "a follow-up" |
| `ScopeId` + scope resolution | **#575** | — |
| Grant / ACL store | **#575** | — |
| Audience floor, per-recipient context filter | **#575** | *consumes* #333's Principals |
| "Who is present" → resolved Principals | **shared seam** | #575 needs it; #333 supplies it. §5.1 is the handoff. |

**The overlap is real, and #568 already showed how it splits.** PR #691 (merged) returns
`{ omadiaUserId?, authSubjectKey? }` — an *identity* answer with **no permission in it**.
#333 widens that return shape (adds roles/attributes); #575 consumes it. Neither has to
touch the other's call sites. That is the pattern to repeat.

### The scheduling consequence — the main output of this document

- **#575 Phase 1 does not depend on #333 at all.** Scopes resolve from channel /
  conversation / routine metadata, none of which needs a role.
- **#575 Phase 2 (grants + audience floor) *does* depend on #333**, because the floor
  intersects *entitlements*, and `ChatParticipant` carries none (§5.1).

**Therefore: start #575 Phase 1 now; #333 must land before #575 Phase 2.** The two issues are
sequential, not parallel, and the seam between them is the participant→Principal conversion.

---

## 7. Q5 — What does #579 minimally need? (measured: almost nothing)

**Finding: PR #681 does not consume a scope model, does not need one to merge, and is not
actually blocked.** This contradicts the premise that opened this wave, and it is the most
consequential measurement in the document.

Measured on the PR head (`sneumannb5/omadia` @ `716a1cf5`):

- `tightenPosture(floor, requested)` (`harness-channel-sdk/src/securityPosture.ts:66-71`)
  takes **two postures and no scope id**. It is a pure two-argument max over
  `POSTURE_ORDER`.
- `security_posture_scope` (`harness-orchestrator/src/plugin.ts:358-393`) is a **single
  deployment-wide setup field** parsed as a `SecurityPosture` *value*. "Scope" there means
  "the non-org level", and there is exactly one of them, and it is **anonymous**.

So #681 implements a **two-level hierarchy whose lower level has no identity**. It is
internally consistent and mergeable as-is. What a real scope model adds later is only that
the lower level becomes *many, keyed by `ScopeId`*, and the floor becomes a walk up a
containment chain instead of a single comparison.

### The minimal surface, and it is three things

1. `ScopeId` — the type from **D1**. No store, no grants.
2. `scopeAncestors(scope): ScopeId[]` — the containment chain (`personal` ⊂ `group` ⊂ `org`).
3. `resolvePostureFor(scope)` — fold `tightenPosture` over that chain.

A type and two pure functions. **None of it needs the ACL store, grants, per-recipient
filtering, or the audience floor.** All three fit inside #575 Phase 1.

### Recommendation: do not block PR #681 — ask for one rename

`tightenPosture` is already the correct fold with the correct signature; making it
scope-aware is an additive caller-side change. The one thing worth asking sneumannb5 for is
a **rename of the setup field**, because it will collide head-on with `ScopeId` and it does
not mean what its name says:

> `security_posture_scope` → **`security_posture_override`**

That is decision **D5**. It costs one field rename now and prevents a permanent
two-meanings-of-scope ambiguity in the setup surface.

---

## 8. Decisions required before Phase 1

| ID | Decision | Recommendation | If deferred |
|---|---|---|---|
| **D1** | `ScopeId` shape — 6 variants incl. `system:` and `unscoped`, `conversation` over `channel`, drop `team` | §3 | Phase 1 cannot start |
| **D2** | Does `sessionScope: string` change in the **published** channel-SDK contract? | **No** — keep `string` at the plugin boundary, type internally; parse at ingress. *Now measured:* consumed in both private plugins' `kernel-types.ts` and ~25 call sites in `teamsBot.ts` | breaks byte5 private plugins across a repo boundary, silently |
| **D3** | Does the graph scope key become injective? | **Yes — but as its own PR *before* scope becomes a security boundary** | a silent cross-scope isolation bug (§2.3) |
| **D4** | Mid-turn joiner: snapshot vs re-evaluate | **split by reversibility** — snapshot rendered context, re-evaluate egress | Phase 2 is undefined |
| **D5** | Ask sneumannb5 to rename `security_posture_scope` → `security_posture_override` | **yes**, before #681 merges | permanent name collision in the setup surface |
| **D6** | ~~Confirm `'teams-unknown'` / `'unknown'` have no producer in `omadia-byte5-plugins`~~ | ✅ **RESOLVED by measurement — answer was NO.** `teams-unknown` has a live producer (`teamsBot.ts:440-441`); the denylist entry must be **expressed in the type, never deleted**. See §2.2. | — |
| **D7** | *(new, raised by D6)* Do the private channel plugins keep building `sessionScope` themselves, or move onto the typed resolver? | **move them** — otherwise `ScopeId` governs only the paths that were already safe, and the two real production channels stay untyped | the type is decorative for actual channel traffic |

---

## 9. Phase 1 preview (not authorized by this document)

For reference only, so the decisions above can be judged against what they enable:

- `ScopeId` + a resolution service; `sessionScope` stays a `string` at the surface (D2) but
  is produced internally from the type.
- **The proof that the model holds: `directLineSticky.ts` deletes `SHARED_SCOPES` and
  `SYNTHETIC_SCOPE_PREFIXES` and asks the type instead.** If the type cannot express those
  three refusals (`no-scope`, `shared-scope`, `synthetic-scope`) it is the wrong type.
- The three-function surface for #579 (§7).
- **Explicitly not in Phase 1:** ACL store, grants, audience floor, per-recipient filtering,
  and all of #333.

---

## 10. Verification of this document

**Verified** — every `file:line` above was re-read at `origin/main` `e4e892e7`; the producer
inventory (§2.2), the 107-occurrence / 23-file consumer count (§4), the zero-producer result
for `'teams-unknown'`/`'unknown'` (§2.2), the absence of `middleware/src/identity`, and the
`sanitizeScope` transformation (§2.3) are all direct measurements, not readings of the issue
text. PR #681's scope semantics (§7) were read from the PR head commit `716a1cf5`, not from
its description.

**Not verified — carry as open risk:**

1. ~~**Private byte5 plugins were not inspected.**~~ ✅ **Now inspected**
   (`~/sources/omadia-byte5-plugins` @ `7dcce57`) — and the risk materialized. It produced
   two corrections to the first published version of this document: the two production
   channels **bypass `CoreApi`** and build their own scope, and **`'teams-unknown'` has a
   live producer**, so the denylist entry is load-bearing rather than dead (§2.2). It also
   confirmed **D2**: `sessionScope?: string` is consumed in both plugins' `kernel-types.ts`
   (`channel-teams/src/kernel-types.ts:204`, `channel-telegram/src/kernel-types.ts:105`) and
   threaded through ~25 call sites in `teamsBot.ts` alone — keeping `string` at the plugin
   boundary is now measured, not assumed. New open item: **D7**.
2. **The 6/10 decision-vs-mechanical split in §4 is a judgement**, made by reading each
   call site's role, not by attempting the migration. A mechanical entry could turn out to
   need a decision.
3. **`web-ui` was scanned for `sessionScope` and returned nothing**, but the front-end may
   reach the same partition through a different name (e.g. the `sessionId` request field).
   Phase 1 should confirm before assuming the surface is backend-only.
4. **PR #681 may move.** It is open and its head may change; §7's conclusions are pinned to
   `716a1cf5`.

**A premise this measurement falsified:** the wave framing lists **#582** alongside #579 as
blocked on the missing scope model. #582 is a deployment-directory contract with no scope
concept in it (§2.4, correction 4). Only #579 has the dependency — and §7 shows even that
one is far weaker than assumed.
