# Cross-Channel Conversation Memory

| | |
|---|---|
| **Status** | Proposed |
| **Capabilities (manifest refs)** | `platformIdentity@1`, `crossChannelConversationMemory@1` |
| **Service-registry keys (runtime)** | `platformIdentity`, `crossChannelConversationMemory` |
| **Plugins (provider candidates)** | `@omadia/platform-identity-neon`, `@omadia/platform-identity-inmemory`, `@omadia/cross-channel-conversation-memory-neon`, `@omadia/cross-channel-conversation-memory-inmemory` |
| **Owners** | omadia-middleware (providers); omadia-ui Tier-2 orchestrator (first consumer); channel-plugin maintainers (write path) |
| **Depends on** | `plugin-api` PluginContext / capability resolver, `harness-channel-sdk` `ConversationHistoryStore` contract, `harness-plugin-privacy-guard` (soft), `harness-orchestrator` `TurnContextValue` extension (specified in §10) |

## 1. Context & Motivation

**Scenario.** A user researches on Telegram during the morning commute,
then opens the omadia-ui desktop app at the office. The Tier-2
orchestrator in omadia-ui materializes the prior context across channels
for seamless continuity. omadia-ui CONCEPT.md v0.7 declares a hard
`requires: ['chatAgent@1', 'memoryStore@1', 'crossChannelConversationMemory@1']`
and treats cross-channel memory as an omadia-core responsibility.

**Today's state in omadia main.**

- `ConversationHistoryStore` (`middleware/packages/harness-channel-sdk/src/stores.ts:29`):
  `get(scope)`, `append(scope, turn)`, optional `clear(scope)`. The
  canonical `ConversationTurn` is `{ userMessage, assistantAnswer, timestampMs? }`
  (`stores.ts:15`).
- `InMemoryConversationHistoryStore`
  (`middleware/packages/harness-channel-sdk/src/inMemoryConversationHistory.ts:59`):
  10 turns per scope, 2h TTL, 500 scopes LRU, in-process volatile,
  not concurrency-safe across processes. Does **not** formally implement
  `ConversationHistoryStore` and defines its own internal
  `ConversationTurn` with required `at: number` (pre-existing tech-debt
  noted in §7.2).
- `ChannelUserRef` (`incoming.ts`): `{ kind, id, displayName?, email? }`
  with closed-union `kind`. `PlatformIdentity` is platform-local
  (`platformId = "${kind}:${id}"`); no cross-channel resolution today.
- Scope = channel-native identifier (Teams thread id, Slack channel +
  thread tuple, Telegram chat id). Not user-scoped, not tenant-scoped.
- Privacy redaction (`egressWalker` + `harness-plugin-privacy-guard`)
  runs on egress, after the chat agent produces a result. Redaction does
  not touch persistence today.
- `SessionLogger` writes markdown transcripts to `MemoryStore` at
  `/memories/sessions/<scope>/YYYY-MM-DD.md`. Different code path; stays
  untouched by this RFC.
- `TurnContextValue` (`harness-orchestrator/src/turnContext.ts:34`)
  carries `turnId`, `turnDate`, optional `chatParticipants`,
  `privacyHandle`, `captureRawToolResult`. It does **not** carry
  `tenantId` or `userId`/`userRef` today. Adding those fields is part of
  the work in §10 (and aligns with Phase 12 of the middleware roadmap).
- Slice 2.5 (cross-channel identity merging UI) is on the roadmap, not
  yet implemented.

**Why a capability, not per-channel ad hoc.** Five channel plugins would
each have to re-implement identity binding, durable storage, retention,
tenant isolation, GDPR delete. A single shared capability concentrates
that one place. omadia-ui has already taken the dependency.

**Why now.** omadia-ui-orchestrator cannot ship without it. The
"S-Bahn → office" continuity is the headline UX promise of the desktop
app.

## 2. Non-goals for v1

- Multi-platform account claiming UI (Slice 2.5 owns this; v1 ships the
  data model and the merge entry-point only).
- Summarization or compaction of older turns.
- Semantic or vector recall — no pgvector. Recency plus per-user filter
  is the only retrieval axis in v1.
- HOT / WARM / COLD tiering or score-based decay analogous to
  `harness-knowledge-graph-neon`. CCM is chronological; value fades
  naturally with time. v2 path open.
- Cross-tenant sharing or team memory.
- Replacing or merging `SessionLogger`'s markdown transcript path.
- Retroactively scrubbing content quoted by the assistant in later turns
  (see §12.3).

## 3. Capability split — two capabilities, four plugins

The RFC introduces **two capabilities**, deliberately separated:

- `platformIdentity@1` — resolves `ChannelUserRef → stable userId`,
  manages identity merges, handles GDPR forget.
- `crossChannelConversationMemory@1` — append-only durable conversation
  log keyed by `(tenantId, userId, channel, createdAt)`. Requires
  `platformIdentity@1`.

Each capability ships with a **Neon backend plus in-memory sibling** pair,
mirroring `@omadia/knowledge-graph-neon` /
`@omadia/knowledge-graph-inmemory`:

- `@omadia/platform-identity-neon` + `@omadia/platform-identity-inmemory`
- `@omadia/cross-channel-conversation-memory-neon` +
  `@omadia/cross-channel-conversation-memory-inmemory`

The kernel allows only **one** provider per capability
(`ServicesAccessor.provide` throws on duplicate; `pluginContext.ts:323-325`).
Operators pick Neon for production, in-memory for CI / smoke / local-dev.

### 3.1 In-memory sibling semantics (operational reality)

- Process-local, not concurrency-safe across processes (same caveat as
  `InMemoryConversationHistoryStore`).
- All state lost on restart.
- **Not supported for multi-pod deployments** — cross-pod continuity is
  impossible without a shared store.
- Intended only for CI, smoke probes, local-dev where Postgres is not
  provisioned.

**Contract parity with the Neon variant** — what the in-memory sibling
honors and what it skips. The capability contract is shared; semantic
gaps are listed explicitly so consumers know what they're testing
against:

| Behavior | Neon sibling | In-memory sibling |
|---|---|---|
| `appendTurn` idempotency via `client_message_id` | Postgres UNIQUE + `ON CONFLICT DO NOTHING` | JS `Map` keyed on `(tenantId, clientMessageId)`; second add returns the existing `messageId` |
| `resolveUserId` race-safety (`platformIdentity@1`) | Partial UNIQUE index + `INSERT ON CONFLICT` | `async`-safe via single mutex; functionally equivalent for a single process |
| Verified-email auto-merge (`pi_auto_merge_on_email`) | Partial UNIQUE index | Mirror logic in JS; same observable semantics |
| `redaction_state` lifecycle | Column + async job | Field + same async pass; identical observable states |
| Quotas (count + bytes) | Counters in `ccm_user_quotas` | Per-user counters in `Map` |
| TTL + cap GC passes | Cron job | Same job, walking the in-memory data structures |
| **Durable outbox** | `ccm_outbox` table + `ccm-outbox` job | **Not implemented** — the "destination" IS this process; if it crashes, the data is gone anyway. Sync calls cannot fail with `'timeout'` / `'transport'`. The contract methods exist but never trigger. |
| **Audit table** (`ccm_audit_events`) | Persisted with retention pass | Ring buffer (default 1000 entries), accessible via `/ccm/audit` route on the same plugin — debug aid only, no retention guarantee. |
| Multi-pod | Yes | **No** — single process only. |

This makes the in-memory sibling a useful test target for the
contract methods (idempotency, identity races, redaction lifecycle,
quotas), while being honest about which guarantees only Neon provides.

### 3.2 Pragmatic packaging fallback (optional)

Four packages is the default. If v1 boilerplate is prohibitive, the
capabilities **MAY** be collapsed to one plugin per backend
(`@omadia/platform-memory-neon` + `@omadia/platform-memory-inmemory`)
each publishing both capabilities. Precedent:
`@omadia/knowledge-graph-neon` publishes six capabilities from a single
plugin (`manifest.yaml:44-50`). The capabilities stay separate as
contracts; only the packaging collapses. Slice 2.5 reverses the collapse
with zero consumer churn.

**Default: four packages.**

## 4. Identity model v1 — `platformIdentity@1`

### 4.1 Goal

Stable, opaque `userId` (ULID) that one `ChannelUserRef` maps to
deterministically. Multiple ChannelUserRefs across different channel
kinds **can** resolve to the same `userId` — but only under explicit
conditions, never implicitly.

### 4.2 Auto-derivation rule (opt-in per tenant)

Tenant config `pi_auto_merge_on_email` (default `false`) controls
whether `email`-equality auto-merges:

- **Disabled (default):** every fresh `ChannelUserRef` gets its own
  `userId`. Cross-channel merge happens only via explicit
  `mergeIdentities` call (Slice 2.5 UI or admin tooling).
- **Enabled:** an incoming `ChannelUserRef.email` whose normalized form
  matches an existing `platform_identities.email_normalized` row attaches
  the same `userId` — but only if that row's `email_verified = true`.
  Verified means the channel kind is known to ship trustworthy email
  (Teams AAD, Google Workspace SSO). Slack and Telegram email is
  treated as unverified by default until tenant policy says otherwise.

### 4.3 Edge cases (called out, not hidden)

| Edge | v1 behavior |
|---|---|
| Shared mailbox (`team@…` used by multiple humans) | Auto-merge disabled by default. If enabled, will silently merge — operators MUST set `pi_auto_merge_on_email=false` for tenants with shared mailboxes. |
| Email rename on the same `platformId` | `resolveUserId` keeps the existing `userId`; updates `email_normalized` and `last_seen_at`. No re-merge to a different `userId`. |
| Recycled email (former user's address handed to a new hire) | v1 does NOT detect this. Operator workflow: invoke `forgetUser` for the former employee BEFORE re-issuing the email. Documented limitation; Slice 2.5 covers via revocation flow. |
| Two concurrent first-sights for the same ref | `INSERT … ON CONFLICT (tenant_id, platform_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at RETURNING user_id` makes the second arrival see the first arrival's `userId` deterministically. |
| Unverified email (Telegram, WhatsApp, custom) | `email_verified = false`. Auto-merge ignores. Manual `mergeIdentities` is the only path. |

### 4.4 Capability surface

```ts
// Constants (also exported from @omadia/platform-identity-types)
export const PLATFORM_IDENTITY_SERVICE = 'platformIdentity';
export const PLATFORM_IDENTITY_CAPABILITY = 'platformIdentity@1';

export interface PlatformIdentityCapability {
  resolveUserId(
    tenantId: string,
    ref: ChannelUserRef,
  ): Promise<{ userId: string; isNew: boolean }>;

  mergeIdentities(
    tenantId: string,
    primaryUserId: string,
    secondaryUserId: string,
    source: 'manual' | 'system',
  ): Promise<{ mergedIdentities: number }>;

  forgetUser(
    tenantId: string,
    userId: string,
  ): Promise<{ deletedIdentities: number }>;

  lookupByPlatformId(
    tenantId: string,
    platformId: string,
  ): Promise<{ userId: string } | null>;
}
```

Service-registry contract:

- Manifest declares `provides: ["platformIdentity@1"]`.
- Plugin code calls
  `ctx.services.provide(PLATFORM_IDENTITY_SERVICE, impl)` — bare name,
  no `@1` suffix (see `pluginContext.ts:226-229`).
- Consumers call
  `ctx.services.get<PlatformIdentityCapability>(PLATFORM_IDENTITY_SERVICE)`.

### 4.5 Schema — `platform_identities`

```
tenant_id         TEXT        NOT NULL
platform_id       TEXT        NOT NULL    -- "${kind}:${id}"
user_id           TEXT        NOT NULL    -- ULID
kind              TEXT        NOT NULL    -- ChannelUserRef.kind
channel_id        TEXT        NOT NULL    -- ChannelUserRef.id
display_name      TEXT        NULL
email             TEXT        NULL        -- raw, as the channel provided
email_normalized  TEXT        NULL        -- lower-cased; Gmail-style dot-stripping documented
email_verified    BOOLEAN     NOT NULL DEFAULT false
first_seen_at     TIMESTAMPTZ NOT NULL
last_seen_at      TIMESTAMPTZ NOT NULL
claim_source      TEXT        NOT NULL    -- 'auto-email' | 'manual' | 'system'

PRIMARY KEY (tenant_id, platform_id)
UNIQUE INDEX     (tenant_id, email_normalized)
                 WHERE email_normalized IS NOT NULL AND email_verified = true
INDEX            (tenant_id, user_id)
```

The partial unique index is what makes auto-merge race-safe: a concurrent
second insert with the same verified email triggers a constraint
violation, the resolver catches it, re-reads, and returns the existing
row's `user_id`.

### 4.6 Resolution site

Each channel plugin calls
`platformIdentity.resolveUserId(tenantId, ref)` at ingress, before
invoking the orchestrator. The channel adapter then makes the resolved
`userRef` and `userId` available to downstream code via the
`TurnContextValue` extension specified in §10.

## 5. Storage backend (Neon variant) — `crossChannelConversationMemory@1`

Postgres only, no pgvector for v1. Connection pool, migrations, tenant
binding mirror `@omadia/knowledge-graph-neon` precisely.

### 5.1 Wiring

- Pool: `createNeonPool(await ctx.secrets.get('database_url'))`
  (`harness-knowledge-graph-neon/src/plugin.ts:117,138`).
- Migrations: file-based `.sql` under
  `middleware/packages/harness-cross-channel-conversation-memory-neon/src/migrations/`,
  tracked in a `_ccm_migrations` table, applied in a transaction.
- If `database_url` is missing the plugin publishes **no** capability
  and `activate()` returns a no-op handle, mirroring the KG plugin's
  pattern (`plugin.ts:119-128`).

### 5.2 Tenant binding (matches KG model)

`tenantId` is read at activate time:

```ts
const tenantId =
  ctx.config.get<string>('ccm_tenant_id') ??
  process.env['CCM_TENANT_ID'] ??
  'default';
```

Single tenant per plugin instance. Multi-tenant hosts run multiple host
processes today, one per tenant. Capability methods take `tenantId` as
their first argument for defense-in-depth — the capability impl asserts
`tenantId === boundTenantId` and throws `TenantMismatchError` if not.
No per-call tenant multiplexing in v1.

### 5.3 Schema — `cross_channel_messages`

```
id                  TEXT        NOT NULL   -- server-assigned ULID
tenant_id           TEXT        NOT NULL
user_id             TEXT        NOT NULL   -- from platformIdentity@1
client_message_id   TEXT        NOT NULL   -- adapter-assigned ULID, idempotency key
channel_kind        TEXT        NOT NULL   -- 'teams-aad' | 'slack-user' | ...
channel_scope       TEXT        NOT NULL   -- native channel scope id
canvas_session_id   TEXT        NULL       -- omadia-ui canvas correlation
user_message        TEXT        NOT NULL   -- raw, never redacted at write
assistant_answer    TEXT        NOT NULL   -- raw, never redacted at write
user_message_bytes  INTEGER     NOT NULL CHECK (user_message_bytes >= 0)
assistant_bytes     INTEGER     NOT NULL CHECK (assistant_bytes >= 0)
tool_calls          JSONB       NULL
metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb
redaction_metadata  JSONB       NULL       -- populated by async hook (§8)
redaction_state     TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (redaction_state IN ('pending','clean','redacted'))
created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
expires_at          TIMESTAMPTZ NOT NULL   -- created_at + tenant TTL

PRIMARY KEY (id)
UNIQUE INDEX (tenant_id, client_message_id)
INDEX (tenant_id, user_id, created_at DESC)
INDEX (tenant_id, channel_scope, created_at DESC)
INDEX (tenant_id, expires_at)
INDEX (tenant_id, redaction_state) WHERE redaction_state = 'pending'
```

`client_message_id` is the **idempotency key**. The adapter generates it
once per turn (a fresh ULID, derived from `(turnId, role)` so user-turn
and assistant-turn are distinct rows). Retries from the outbox reuse the
same `client_message_id`. `appendTurn` is implemented as
`INSERT … ON CONFLICT (tenant_id, client_message_id) DO NOTHING RETURNING id`:
the second arrival sees no row returned and treats the operation as
already-committed. No double-counting in quotas (the `INSERT` is
skipped, the trigger that bumps the quota counters runs only on
inserted rows).

`user_id` is **not** a hard FK to `platform_identities`. Reasons:

- The two capabilities are designed to be independently provided
  (different plugins, different DBs theoretically). Cross-plugin FKs
  break that flexibility.
- `forgetUser` orchestrates deletion across both capabilities in a
  single application-level transaction (§8.5).

Integrity contract is application-enforced: every `appendTurn` first
calls `platformIdentity.resolveUserId` (or accepts a pre-resolved
`userId` from `TurnContextValue`) which guarantees the row exists at
write time. Stale `user_id` (after a partial GDPR forget) returns empty
results from reads.

### 5.4 Quotas — `ccm_user_quotas`

```
tenant_id    TEXT        NOT NULL
user_id      TEXT        NOT NULL
turn_count   BIGINT      NOT NULL DEFAULT 0
byte_count   BIGINT      NOT NULL DEFAULT 0
updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()

PRIMARY KEY (tenant_id, user_id)
```

Counters incremented in the same transaction as `INSERT` into
`cross_channel_messages` (`turn_count += 1`,
`byte_count += user_message_bytes + assistant_bytes`). GC decrements
both counters in the same transaction as the `DELETE`. No hot-path
scan.

### 5.5 Outbox — `ccm_outbox`

Bridges fire-and-forget durable writes (§7) for late delivery on
transient failures.

```
id            TEXT        NOT NULL   -- ULID
tenant_id     TEXT        NOT NULL
kind          TEXT        NOT NULL CHECK (kind IN ('append_turn'))
payload       JSONB       NOT NULL   -- carries client_message_id for idempotency
attempts      INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0)
last_error    TEXT        NULL
last_attempt  TIMESTAMPTZ NULL
created_at    TIMESTAMPTZ NOT NULL DEFAULT now()

PRIMARY KEY (id)
INDEX (tenant_id, created_at) WHERE attempts < 5
```

The outbox sits in the **destination** DB. Every outbox payload carries
the `client_message_id` from §5.3, so any number of retries (including
a drain that overlaps with a successful direct write) is idempotent at
the `cross_channel_messages` level.

The `ccm-outbox` job (§12.4) flushes rows with exponential backoff up
to 5 attempts; rows past 5 attempts are left in the table for operator
inspection (`ccm_outbox_dlq_total` counter, §13.1).

### 5.6 Process-local fallback — explicit data-loss disclaimer

When the destination DB itself is **unreachable**, the adapter cannot
write to `ccm_outbox`. The adapter then falls back to a process-local
bounded ring buffer (`ccm_outbox_local`, in-memory, default cap 1024
entries, oldest-dropped). On the next successful capability call, the
adapter drains the local buffer into the durable outbox.

**The local buffer is a recovery aid, not a durability guarantee:**

- On process crash with non-empty local buffer → those entries are
  lost.
- On local-buffer overflow (more than 1024 unsent entries) → oldest
  entries are dropped before newer ones queue, also lost.
- This is a deliberate trade-off: bounded memory, simple code, no disk
  spilling. The **durable outbox in the destination DB is the actual
  durability boundary**. Tenants that need SLA-grade durability must
  deploy with a reachable destination DB at all times (Neon serverless
  is the design assumption).

The adapter emits `ccm_outbox_local_dropped_total` per dropped entry
so operators can alert on extended outages.

## 6. Capability API — `crossChannelConversationMemory@1`

```ts
// Constants
export const CROSS_CHANNEL_CONVERSATION_MEMORY_SERVICE =
  'crossChannelConversationMemory';
export const CROSS_CHANNEL_CONVERSATION_MEMORY_CAPABILITY =
  'crossChannelConversationMemory@1';

// The canonical ConversationTurn is the one in
// harness-channel-sdk/src/stores.ts:15 — { userMessage; assistantAnswer; timestampMs? }.
// The internal type in inMemoryConversationHistory.ts is legacy tech-debt
// (§7.2) and is NOT the contract this capability speaks.

export interface CrossChannelConversationMemoryCapability {
  appendTurn(args: {
    tenantId: string;
    userId: string;             // resolved upstream via platformIdentity@1
    channelKind: string;
    channelScope: string;
    canvasSessionId?: string;
    turn: ConversationTurn;     // canonical: stores.ts shape
    toolCalls?: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<{ messageId: string }>;

  getRecentByUser(
    tenantId: string,
    userId: string,
    opts: {
      limit: number;            // hard-cap 100
      sinceMs?: number;         // epoch ms; default = no lower bound
      excludeCanvasSessionId?: string;
      channelKinds?: string[];  // optional filter
      includeRaw?: boolean;     // admin-only; default false → redacted; audit-logged when true
    },
  ): Promise<CrossChannelTurn[]>;

  // Compat shim for today's ConversationHistoryStore.get() callers.
  getByChannelScope(
    tenantId: string,
    channelScope: string,
    limit: number,
  ): Promise<ConversationTurn[]>;

  forgetByUser(
    tenantId: string,
    userId: string,
  ): Promise<{ deletedTurns: number; deletedAuditRows: number }>;
}

// Structured error contract for the adapter's failure handling (§7.4).
// Implementations of the capability MUST raise CcmAppendError on
// appendTurn failures and populate `code` and `clientMessageId`
// accurately. Other methods may raise standard Error subclasses.
//
// All readonly fields MUST be set by the constructor at throw-time —
// the impl is expected to use a thin subclass / factory that takes
// `{ code, messageId?, clientMessageId, cause? }` and assigns every
// field, so consumers never see a partially-initialised instance.
export class CcmAppendError extends Error {
  readonly code:
    | 'committed'   // server-side error AFTER row was committed; messageId set
    | 'rejected'    // server-side validation rejection; do NOT retry
    | 'timeout'     // sync call timed out; outcome unknown — retry via outbox
    | 'transport';  // network / destination unreachable — retry via outbox
  readonly messageId?: string;        // present iff code === 'committed'
  readonly clientMessageId: string;   // always set; idempotency key
}

export interface CrossChannelTurn extends ConversationTurn {
  id: string;
  channelKind: string;
  channelScope: string;
  canvasSessionId?: string;
  toolCalls?: unknown;
  metadata: Record<string, unknown>;
  createdAtMs: number;
  redactionState: 'pending' | 'clean' | 'redacted';
}
```

Service-registry contract:

- Manifest declares `provides: ["crossChannelConversationMemory@1"]`.
- Plugin code calls
  `ctx.services.provide(CROSS_CHANNEL_CONVERSATION_MEMORY_SERVICE, impl)`.
- Consumers call
  `ctx.services.get<CrossChannelConversationMemoryCapability>(CROSS_CHANNEL_CONVERSATION_MEMORY_SERVICE)`.

### Relation to `ConversationHistoryStore`

The `ConversationHistoryStore` interface (`stores.ts:29`) stays
unchanged. The new capability is **durable backing**.
`InMemoryConversationHistoryStore` stays alive as a per-channel hot
cache — the 10-turn read path stays fast and offline-tolerant. The
bridge is the new `DurableConversationHistoryStore` adapter (§7).

## 7. Write path & adapter

### 7.1 Adapter overview

`DurableConversationHistoryStore` in
`middleware/packages/harness-channel-sdk/src/durableConversationHistory.ts`
implements `ConversationHistoryStore` from `stores.ts` cleanly and fans
out:

- `append(scope, turn)`:
  1. delegate to an inner `InMemoryConversationHistoryStore` (ring-buffer
     semantics, unchanged) after the type bridge below,
  2. enqueue a `appendTurn` call to the capability with the userId /
     tenantId resolved from `turnContext.current()` (§10).
- `get(scope)`:
  1. inner in-memory store first,
  2. on cold start (empty bucket), hydrate up to `limit` turns from
     `getByChannelScope(tenantId, scope, limit)`.

Latency stays on the in-memory path. Durable write is best-effort; the
hot turn never blocks on the capability call.

### 7.2 Type bridge — the two `ConversationTurn`s

The SDK has two `ConversationTurn` types today (pre-existing tech-debt,
predates this RFC):

- `stores.ts:15` — public contract, `timestampMs?` optional.
- `inMemoryConversationHistory.ts:23` — internal, `at: number` required.

The adapter implements the **`stores.ts` contract**, accepting
`{ userMessage, assistantAnswer, timestampMs? }`. When delegating to the
inner in-memory class it converts:

```ts
const at = turn.timestampMs ?? Date.now();
this.inner.append(scope, { userMessage, assistantAnswer, at });
```

When hydrating from the capability it converts the other way
(`createdAtMs → timestampMs`). The legacy internal type stays untouched
to keep this PR additive; a follow-up cleanup PR may unify the two
types, but is out of scope here.

### 7.3 Capability discovery & graceful degradation

The adapter calls
`ctx.services.get<CrossChannelConversationMemoryCapability>(CROSS_CHANNEL_CONVERSATION_MEMORY_SERVICE)`
at construction. If the capability is not registered (CI / dev / Neon
plugin absent), the adapter behaves identically to
`InMemoryConversationHistoryStore`. No breaking change.

### 7.4 Failure handling — structured error taxonomy

The adapter generates a fresh `client_message_id` (ULID) before
calling `appendTurn`. The call is wrapped in `try/catch` and branches
on the `CcmAppendError.code` (§6):

| `code` | Adapter behavior |
|---|---|
| (success) | Done. Local outbox drain attempted if non-empty. |
| `'committed'` | Row was inserted server-side; only the response failed. Adapter treats as success. No retry, no outbox write (the row is already there; the durable outbox would just create a `DO NOTHING` no-op via `client_message_id` uniqueness anyway). Log `info` once for observability. |
| `'rejected'` | Server validated and rejected (bad payload, tenant mismatch, schema violation). Do **not** retry. Log `warn` with the rejection reason; the turn is lost in the durable store but the in-memory inner store still has it for the current scope. |
| `'timeout'` / `'transport'` | Outcome unknown or no commit. Adapter writes the payload (including `client_message_id`) into `ccm_outbox` via a separate idempotent admin call against the capability. If the destination DB itself is unreachable, fall back to `ccm_outbox_local` (§5.6). |

Distinguishing `'committed'` from `'rejected'` requires the capability
impl to know whether the transaction reached commit. Postgres makes
this directly available: server errors raised after `COMMIT` (rare —
network drop on `COMMIT;` ACK) vs. errors that originate during the
INSERT itself.

All failures are logged via **`ctx.log`** — not `ctx.notifications`,
which is for cross-channel **user** notifications
(`pluginContext.ts:98-102`).

A plugin-owned counter `ccm_write_failures_total{code}` is incremented
per failure with the `code` label. v1 metrics surface is plugin-internal
(the PluginContext has no metrics accessor today — see §13).

### 7.5 Channels opt in per PR

Each of `harness-channel-teams`, `harness-channel-slack`,
`harness-channel-telegram`, `harness-channel-web-chat` replaces its
`new InMemoryConversationHistoryStore()` call site with
`new DurableConversationHistoryStore(...)` in its own PR. Channel teams
review independently. Roll-back is per-channel.

## 8. Privacy & redaction

### 8.1 Decision

**Persist the raw turn.** Egress-redaction (`egressWalker` → privacy
service → `applyEgressReplacements`) keeps holding for outbound traffic;
the existing pipeline does not change.

### 8.2 Rationale

Egress PII filters are tuned for trimming user-facing text. Redacting on
persist would silently corrupt continuity ("you mentioned Vendor X
yesterday" fails when X was scrubbed). Storage fidelity is a different
problem from presentation fidelity.

### 8.3 Read-time behavior — handling the redaction window

The window between `INSERT` and the async redaction job completing is
real and must be bounded:

| State (`redaction_state`) | Default read (`includeRaw=false`) | Privileged read (`includeRaw=true`, admin) |
|---|---|---|
| `pending` | Row excluded from results; emit `ccm_reads_redaction_pending_total` counter | Row returned, audited |
| `clean` | Row returned verbatim | Row returned, audited |
| `redacted` | Row returned with masks applied from `redaction_metadata` | Row returned verbatim, audited |

"Exclude pending rows on default read" is opinionated: it trades a
temporary recall gap (seconds, until the redaction job catches up) for
never leaking unredacted text to a default consumer. The counter lets
operators detect when the redaction job is falling behind.

A tenant configuration flag `ccm_redact_on_persist` (default `false`)
forces an inline redaction pass before append. Strict-compliance tenants
set this to `true`. With the flag on, rows land with
`redaction_state='clean'` (or `'redacted'`) and the read-time exclusion
never triggers.

### 8.4 Audit — the right surface

`includeRaw: true` reads and identity-mutating operations
(`forgetUser`, `mergeIdentities`) write a row into a dedicated audit
table:

```
ccm_audit_events
  id          TEXT        NOT NULL   -- ULID
  tenant_id   TEXT        NOT NULL
  actor       TEXT        NOT NULL   -- agentId of the calling plugin
  op          TEXT        NOT NULL
              CHECK (op IN ('read_raw','forget_user','merge_identities'))
  target_id   TEXT        NULL       -- messageId for 'read_raw', secondaryUserId for merge, null for forget
  user_id     TEXT        NULL       -- nullified on GDPR forget (see retention below)
  detail      JSONB       NULL       -- ENUMERATED FIELDS ONLY (see below)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()

PRIMARY KEY (id)
INDEX (tenant_id, created_at DESC)
INDEX (tenant_id, user_id, created_at DESC) WHERE user_id IS NOT NULL
```

**`detail` JSONB is bounded.** Free-form turn content is **never** stored
in audit. The allowed keys are enumerated per op:

| `op` | Allowed `detail` keys |
|---|---|
| `'read_raw'` | `limit`, `sinceMs`, `excludeCanvasSessionId`, `channelKinds`, `returnedCount` |
| `'forget_user'` | `deletedTurns`, `deletedIdentities`, `deletedAuditRows`, `nullifiedAuditRows` |
| `'merge_identities'` | `primaryUserId`, `secondaryUserId`, `mergedIdentities`, `source` |

The capability impl validates the `detail` shape before insert; any
extra key throws. This makes audit rows lossless for compliance review
without becoming a secondary PII store.

Written in-transaction with the audited operation. **Not** routed
through `ctx.notifications` (broadcast to channels — wrong surface) nor
through `ctx.log` (volatile — wrong retention). Audit data is durable,
queryable, exportable.

### 8.4.1 Audit retention & GDPR interaction

Audit rows are themselves subject to retention:

- `ccm_audit_retention_days` (tenant config, default `365`) — audit
  rows older than this are deleted by the `ccm-gc` job's audit pass
  (§12.2 pass 4).
- On `forgetByUser(tenantId, userId)`: audit rows for the user are
  handled in two ways:
  1. Rows where `op IN ('read_raw')` referencing the forgotten user
     are **deleted** in the same transaction.
  2. Rows where `op IN ('forget_user','merge_identities')` referencing
     the forgotten user have their `user_id` and `target_id` columns
     **nullified** (but the row is retained). Rationale: a record that
     "the user was forgotten" is itself a compliance artifact that
     auditors may need to see; removing the PII identifier while
     keeping the event satisfies both GDPR minimization and
     audit-trail integrity.
- The `deletedAuditRows` count returned by `forgetByUser` (§6) reflects
  the rows actually deleted (case 1); the nullified rows are returned
  separately if needed via `detail.nullifiedAuditRows` in the
  associated `forget_user` audit event.

### 8.5 GDPR forget

```
forgetUser(tenantId, userId)         // on platformIdentity@1
  → forgetByUser(tenantId, userId)   // on crossChannelConversationMemory@1
```

Both run in a single application-level transaction in the destination
DB:

1. `DELETE FROM cross_channel_messages WHERE tenant_id=$1 AND user_id=$2`
2. `DELETE FROM ccm_user_quotas WHERE tenant_id=$1 AND user_id=$2`
3. `DELETE FROM platform_identities WHERE tenant_id=$1 AND user_id=$2`
4. Insert audit row (`op='forget_user'`)

The channel plugins' in-memory hot caches
(`InMemoryConversationHistoryStore`) are **not** purged automatically —
they are scope-keyed, not user-keyed, and they naturally expire within
2 hours of inactivity. For strict-compliance tenants, the adapter
exposes `clearHotCacheForUser(userId)` (a new optional method on
`DurableConversationHistoryStore`) that walks its inner store and drops
buckets whose recent turns contain the target user. v1 ships the method
but does not invoke it from `forgetUser` automatically; the tenant
admin tool decides.

### 8.6 Known limitation — assistant quotes survive forget

If the assistant quoted PII in a prior turn (`"you mentioned Vendor X"`)
and the *original* turn is the only one being forgotten, the quote in
the later turn remains. v1 does not retroactively scrub. Documented
limitation; tenants requiring strict erasure must enable
`ccm_redact_on_persist` so the quote is masked at write time.

## 9. Consumer inventory

### 9.1 Primary

**omadia-ui Tier-2 orchestrator** — reads `getRecentByUser` at
turn-start, writes through `DurableConversationHistoryStore` after each
turn. Mechanics in §10.

### 9.2 Plausible next consumers (no commitment in v1)

- **search-agent** — read-only, recent turns inform query expansion and
  disambiguation across channels.
- **knowledge-graph reference-agents** — read-only, entity grounding
  ("user already discussed Vendor X yesterday on Telegram").
- **builder-ui** — read-only, "what was I working on" panel across
  sessions and devices.

### 9.3 Out of scope as consumer in v1

- `SessionLogger` keeps its markdown transcript path.
- `QualityGuard` has no cross-channel signal need.

Consumers discover the capability via
`ctx.services.get<CrossChannelConversationMemoryCapability>(CROSS_CHANNEL_CONVERSATION_MEMORY_SERVICE)`.
Absence degrades gracefully — empty arrays, no error.

## 10. Primary consumer mechanics — omadia-ui Tier-2 orchestrator

### 10.1 Pre-requisite: `TurnContextValue` extension

The orchestrator's per-turn context
(`harness-orchestrator/src/turnContext.ts:34`) does **not** carry
`tenantId` or user identity today. This RFC depends on a small additive
change to that type, which lands in the same PR that adds the adapter
(PR 4 in §15):

```ts
export interface TurnContextValue {
  turnId: string;
  turnDate: string;
  chatParticipants?: ChatParticipantsProvider;
  privacyHandle?: PrivacyTurnHandle;
  captureRawToolResult?: (toolName: string, rawResult: string) => void;

  // NEW (this RFC):
  tenantId?: string;                  // channel adapter populates at ingress
  originatorUserRef?: ChannelUserRef; // raw ref, kept opaque to the orchestrator
  originatorUserId?: string;          // resolved via platformIdentity@1
  canvasSessionId?: string;           // omadia-ui orchestrator populates at ingress
}
```

All four new fields are **optional**. Tools, sub-agents and routine
handlers that run outside a channel-originated turn (background jobs,
backfill scripts, ad-hoc invocations) will see `undefined` and the
downstream code treats them as "no cross-channel context available" —
the adapter skips its durable fan-out, the orchestrator skips its
cross-channel read. No throw, no crash, byte-identical to today's
behavior when CCM is not installed.

Adding `tenantId` to `TurnContextValue` is also the work referenced by
Phase 12 of `docs/middleware-agent-handoff.md` (diagram-cache tenancy).
It lands as part of this RFC's PR 4 and Phase 12 absorbs it
retroactively — no duplicate work.

### 10.2 Pipeline placement

```
turn-start
  ├─ channel adapter (already populated):
  │     turnContext.run({ ...prev, tenantId, originatorUserRef, originatorUserId }, ...)
  ├─ READ : crossChannelConversationMemory.getRecentByUser(tenantId, userId, {...})
  ├─ build prompt   (system + cross-channel summary block + current session turns + user message)
  ├─ chatAgent.invoke(prompt)
  ├─ WRITE: DurableConversationHistoryStore.append(scope, turn)
  │            → reads tenantId, originatorUserId from turnContext
  │            → calls crossChannelConversationMemory.appendTurn(...)
turn-end
```

### 10.3 userId resolution

The channel adapter is responsible for populating
`turnContext.current().originatorUserId` before invoking the
orchestrator. It does so by:

1. Receiving the `IncomingTurn` with `userRef`.
2. Calling `platformIdentity.resolveUserId(tenantId, userRef)` and
   caching the result for the duration of the turn.
3. Calling `turnContext.run({ ...prev, tenantId, originatorUserRef, originatorUserId }, fn)`.

The orchestrator reads `turnContext.current()?.originatorUserId`
directly — no per-call resolution, no extra DB roundtrip per turn.

**Cache spec.** The "for the duration of the turn" cache is a
`Map<string, string>` keyed by `(tenantId + ':' + platformId)` mapping
to `userId`. It lives on the channel adapter's per-turn closure (the
AsyncLocalStorage scope opened by `turnContext.run(...)`), not on a
process-wide singleton. Multiple `ChannelUserRef`s in one turn (group
chat with multiple senders) each get their own cache entry; the cache
is dropped automatically when the turn's ALS frame exits.

If `originatorUserId` is missing (very first ingress, ever; or
`platformIdentity@1` not installed), the orchestrator skips the read
step and proceeds with empty cross-channel context. The write step
still happens via the adapter, which will skip its durable fan-out if
`originatorUserId` is missing and just delegate to the in-memory inner
store.

### 10.4 Read call (turn-start)

```ts
const ctxValue = turnContext.current();
if (!ctxValue?.tenantId || !ctxValue?.originatorUserId) {
  return [];
}
const recent = await ccm.getRecentByUser(
  ctxValue.tenantId,
  ctxValue.originatorUserId,
  {
    limit: 20,
    sinceMs: Date.now() - 3 * 24 * 60 * 60 * 1000,    // 3-day window
    excludeCanvasSessionId: ctxValue.canvasSessionId, // skip current session
  },
);
```

The orchestrator does **not** inject these verbatim into the LLM
context. It builds a compact summary block — a bullet list of
`{ channelKind, relativeAge, role, content_truncated_200_chars }` for
the top 8 by recency, prepended to the system prompt under
`## Recent context from other channels`. This caps cross-channel
injection at ~2 KB regardless of history depth.

### 10.5 Write call (turn-end)

Through the adapter, no direct capability call from the orchestrator:

```ts
await durableStore.append(scope, { userMessage, assistantAnswer, timestampMs });
```

The adapter reads `tenantId` and `originatorUserId` from
`turnContext.current()` and calls
`crossChannelConversationMemory.appendTurn({ tenantId, userId, channelKind, channelScope, turn, ... })`.
The orchestrator never blocks on this.

### 10.6 Relevance strategy

Last 20 turns within 3 days, scoped to the same `userId` across all
channels, current canvas-session excluded. Sorted by recency only.
Semantic relevance is explicitly out of scope for v1.

### 10.7 Failure mode

Capability missing, throws, or returns empty: orchestrator emits one
`ctx.log` warn per session with `{ userId, reason }`, proceeds with
empty cross-channel context, **does not block the turn**. The write
side is already best-effort by adapter design. Counter
`ccm_write_failures_total` is incremented; the counter is
plugin-internal until a metrics accessor lands in PluginContext (§13).

## 11. Cross-tenant isolation

- `tenant_id TEXT NOT NULL` on every table. No `DEFAULT 'default'` at
  the column level — stricter than KG's `0001_graph_init.sql`.
- Every query at the capability impl layer binds `WHERE tenant_id = $1`
  before any other predicate.
- `tenantId` is **bound at plugin activate-time** from
  `ctx.config.get('ccm_tenant_id')` (single-tenant per plugin instance,
  same model as KG; §5.2). Capability methods take `tenantId` as their
  first argument; the impl asserts `args.tenantId === boundTenantId`
  and throws `TenantMismatchError` on mismatch. The assertion catches
  caller misconfiguration (forgotten plumbing, wrong tenant injected by
  a buggy adapter) — not malicious cross-tenant reads, which the
  single-tenant binding prevents structurally.
- **Fail-closed:** if a caller passes `tenantId === undefined` or empty
  string the capability throws — no silent fallback. No admin override.
- `pi_tenant_id` (platform-identity plugin) and `ccm_tenant_id` (CCM
  plugin) MUST agree per host process. The capability constructors emit
  a startup `ctx.log` warning if they detect a mismatch by sharing the
  service registry (each capability exposes a `getBoundTenantId()`
  introspection method).
- Application-level isolation, not RLS — same operational model as KG.

## 12. Capacity & lifecycle

### 12.1 Defaults (all configurable via `ctx.config`)

- `ccm_ttl_days` = 90 (per-turn TTL).
- `ccm_user_msg_cap` = 10000 (per-user hard cap on `turn_count`).
- `ccm_user_byte_cap` = 50_000_000 (per-user hard cap on `byte_count`,
  ~50 MB; corresponds to roughly 12M tokens at typical UTF-8 density).
- `ccm_gc_cron` = `"0 4 * * *"` (daily 04:00 UTC).
- `ccm_gc_interval_minutes` = empty (cron is used by default).

### 12.2 Single job — `ccm-gc`

Cron or interval, `overlap: 'skip'` (`pluginContext.ts:176`). Four
passes per sweep, in order:

1. **TTL pass:** `DELETE FROM cross_channel_messages WHERE tenant_id=$1
   AND expires_at < now()`; decrement `ccm_user_quotas` in the same
   transaction. Chunked to 10k rows per statement to keep lock windows
   short.
2. **Count cap pass:** for each `(tenant_id, user_id)` with
   `turn_count > ccm_user_msg_cap`, delete the oldest excess rows;
   decrement counters.
3. **Byte cap pass:** for each `(tenant_id, user_id)` with
   `byte_count > ccm_user_byte_cap`, delete the oldest rows until below
   cap; decrement counters.
4. **Audit retention pass:** `DELETE FROM ccm_audit_events WHERE
   tenant_id=$1 AND created_at < now() - INTERVAL '<retention> days'`,
   where `<retention>` = `ccm_audit_retention_days` (default 365).
   Chunked, same lock-window discipline.

No score-decay table. No HOT / WARM / COLD tiering. Chronological log;
value fades with time. v2 path to score-decay stays open.

### 12.3 Anti-quoting limitation

GC deletes the *original* turn but **cannot** retroactively scrub
content that the assistant quoted in *later* turns. Operators who need
strict scrub MUST enable `ccm_redact_on_persist` so the quote is masked
at write time. Documented; not solvable without summarization /
compaction (deferred to v2).

### 12.4 Outbox flush job — `ccm-outbox`

Separate from `ccm-gc`. Cron `"*/2 * * * *"` (every 2 minutes), drains
`ccm_outbox` rows with `attempts < 5` using exponential backoff
`(2^attempts * 30s)`. Rows exceeding 5 attempts stay in the table for
operator inspection; emit `ccm_outbox_dlq_total` counter.

## 13. Observability

PluginContext (`pluginContext.ts:31-147`) does **not** expose a metrics
accessor today (it exposes `log`, `secrets`, `config`, `services`,
`jobs`, `routes`, `notifications`, `tools`, `uiRoutes`, optional
`scratch`/`http`/`memory`/`subAgent`/`knowledgeGraph`/`llm`). The
manifest loader (`middleware/src/plugins/manifestLoader.ts:465-487`)
extracts `permissions.{memory,graph,network,subAgents,llm}` — there is
**no** `permissions.routes` permission key today; `RoutesAccessor`
(`pluginContext.ts:470-472`) registers routers with no permission gate
and the kernel does not inject auth/CORS middleware around them
(per the doc-comment at `pluginContext.ts:464-468`).

v1 of CCM therefore takes the same path the channel-teams plugin's
`/metrics` route takes: plugin-local Prometheus-style registry,
exposed via a normal `ctx.routes.register('/ccm', metricsRouter)`
call. Authentication / authorization on the route is the plugin's own
responsibility (e.g., a static token check against
`ctx.config.get('ccm_metrics_token')`, or operator-managed
reverse-proxy IP allow-listing). The manifest does **not** declare a
permissions key for the route.

When a future PluginContext extension adds `ctx.metrics`, CCM
migrates.

### 13.1 Counters

| Counter | When incremented |
|---|---|
| `ccm_appends_total{channel_kind}` | Each successful `appendTurn` |
| `ccm_append_failures_total{stage}` | Capability call failed (stage = `'sync'` or `'outbox-drain'`) |
| `ccm_outbox_pending` | Gauge of `ccm_outbox` row count where `attempts < 5` |
| `ccm_outbox_dlq_total` | Outbox rows exceeding 5 attempts |
| `ccm_reads_total{kind}` | `getRecentByUser` / `getByChannelScope` (kind discriminates) |
| `ccm_reads_redaction_pending_total` | Default-read excluded a `pending` row |
| `ccm_reads_raw_total` | Privileged `includeRaw=true` reads |
| `ccm_gc_deletes_total{pass}` | GC deletions (pass = `'ttl'`, `'count'`, `'bytes'`, `'audit'`) |

### 13.2 Performance targets

- `appendTurn` p99 < 100 ms (single-row INSERT + quota UPDATE).
- `getRecentByUser` p99 < 50 ms at `limit ≤ 20` (covering index on
  `(tenant_id, user_id, created_at DESC)`).
- `ccm-gc` sweep completes in < 5 minutes for a tenant with 1M turns
  (chunked DELETEs in batches of 10k).

### 13.3 Eval / test matrix per PR

| PR | Test surface |
|---|---|
| 2 (`platform-identity`) | Unit: resolve-new-user, resolve-existing-by-email (verified / unverified), concurrent first-sight race, merge, forget. Integration: Neon ephemeral branch. |
| 3 (`ccm`) | Unit: append + getRecentByUser round-trip; tenant assertion; quotas incremented/decremented; GC TTL pass, count pass, byte pass; outbox drain + DLQ; pending-read exclusion. Integration: Neon ephemeral branch with full PII pipeline. |
| 4 (adapter) | Capability registered and absent: capability-present writes durable, capability-absent is byte-identical to InMemory. TurnContextValue propagation tested via the harness-orchestrator. |
| 5–8 (channels) | Each: one e2e test asserting a turn written via channel X is readable via the capability by `userId` from a second channel adapter. |

## 14. Plugin manifests

### 14.1 `@omadia/cross-channel-conversation-memory-neon` (sketch)

```yaml
schema_version: "1"
identity:
  id: "@omadia/cross-channel-conversation-memory-neon"
  name: "Cross-Channel Conversation Memory (Neon Postgres)"
  version: "0.1.0"
  kind: "extension"
  domain: "core.conversation-memory"
  description: "Durable per-user conversation log across channels. Neon
    Postgres backend. Provides crossChannelConversationMemory@1.
    Requires platformIdentity@1. Mutual exclusion with
    @omadia/cross-channel-conversation-memory-inmemory."
compat:
  core: ">=1.0 <2.0"
  node: ">=20"
lifecycle: { entry: "dist/plugin.js" }
provides:
  - "crossChannelConversationMemory@1"
requires:
  - "platformIdentity@1"
setup:
  fields:
    - { id: "database_url",            type: "secret", required: false }
    - { id: "ccm_tenant_id",           type: "text",   required: false }
    - { id: "ccm_ttl_days",            type: "number", required: false }
    - { id: "ccm_user_msg_cap",        type: "number", required: false }
    - { id: "ccm_user_byte_cap",       type: "number", required: false }
    - { id: "ccm_gc_enabled",          type: "text",   required: false }
    - { id: "ccm_gc_cron",             type: "text",   required: false }
    - { id: "ccm_gc_interval_minutes", type: "number", required: false }
    - { id: "ccm_redact_on_persist",   type: "text",   required: false }
permissions:
  network: { outbound: ["neon-database"] }
integrations:
  - id: "neon_database"
    kind: "tcp"
    target: "Neon Postgres serverless (DATABASE_URL pgwire endpoint)"
    auth_from: "database_url"
```

### 14.2 `@omadia/platform-identity-neon` (sketch)

Same shape with `provides: ["platformIdentity@1"]`, no `requires`, its
own setup fields for `database_url`, `pi_tenant_id`,
`pi_auto_merge_on_email`.

In-memory siblings: identical manifests with `id` / `name` swapped, no
`database_url` field, same `provides:`, no `integrations`. Mutual
exclusion handled by the kernel's single-provider-per-service-key rule
(`pluginContext.ts:323-325`).

## 15. PR sequence

All PRs are **source-mergeable independently**; **deployment** is
gated by activation order. `requires` is checked at boot
(`pluginContext.ts:224-225`): the kernel refuses to activate a plugin
whose `requires` are not matched by another plugin's `provides`. The
operator must therefore install upstream providers first.

| # | PR title (conventional commit) | Adds / changes | Deploy-prerequisite |
|---|---|---|---|
| **1** | `docs(rfc): cross-channel conversation memory + platform identity` | This RFC, `middleware-agent-handoff.md` Phase 13 entry, CHANGELOG | — |
| 2 | `feat(harness-platform-identity-*): provide platformIdentity@1 (neon + inmemory)` | Two new packages, migrations (`_pi_migrations`, `platform_identities`), full impl | — |
| 3 | `feat(harness-cross-channel-conversation-memory-*): provide crossChannelConversationMemory@1 (neon + inmemory)` | Two new packages, migrations (`_ccm_migrations`, `cross_channel_messages`, `ccm_user_quotas`, `ccm_outbox`, `ccm_audit_events`), full impl, `ccm-gc` + `ccm-outbox` jobs | PR 2 deployed first |
| 4 | `feat(harness-channel-sdk): DurableConversationHistoryStore adapter + TurnContextValue extension` | New `durableConversationHistory.ts`; `TurnContextValue` gains `tenantId?`, `originatorUserRef?`, `originatorUserId?` (additive, optional fields) | PR 3 deployed if durable mode used |
| 5 | `feat(harness-channel-teams): opt into DurableConversationHistoryStore` | Swap store construction; populate `TurnContextValue` extensions at ingress | PR 4 deployed |
| 6 | `feat(harness-channel-slack): opt into DurableConversationHistoryStore` | " | PR 4 deployed |
| 7 | `feat(harness-channel-telegram): opt into DurableConversationHistoryStore` | " | PR 4 deployed |
| 8 | `feat(harness-channel-web-chat): opt into DurableConversationHistoryStore` | " | PR 4 deployed |
| 9 | `feat(orchestrator): consume crossChannelConversationMemory@1` *(in omadia-ui repo)* | Read-at-turn-start, summary block, write via adapter | PRs 3+4 deployed |

PR 1 is **docs-only** and lands first to lock the contract for Codex
review. End-to-end verification of the capability happens at PR 3
(provider tests) and PR 9 (omadia-ui smoke).

### 15.1 Required doc updates per implementation PR

AGENTS.md (lines 17-26) mandates specific doc updates per change type.
This RFC binds the implementation PRs accordingly:

| PR | `.env.example` | CHANGELOG migration IDs | `security-architecture.md` | `middleware-agent-handoff.md` |
|---|---|---|---|---|
| 2 | `PI_DATABASE_URL`, `PI_TENANT_ID`, `PI_AUTO_MERGE_ON_EMAIL` | `pi/0001_init.sql` (platform_identities + partial unique email index) | new section on raw email retention + verified-email semantics | §3/§8 |
| 3 | `CCM_DATABASE_URL`, `CCM_TENANT_ID`, all `CCM_*` config fields including `CCM_AUDIT_RETENTION_DAYS`, `CCM_METRICS_TOKEN` | `ccm/0001_init.sql` (cross_channel_messages + ccm_user_quotas + ccm_outbox + ccm_audit_events with CHECK constraints) | new section on raw turn retention + `redaction_state` semantics + audit events + audit retention | §3/§8 |
| 4 | — | — | — | §3 (adapter), §13 (Phase 12 absorption) |
| 5–8 | — | — | — | §3 channel-by-channel note |

Migration filenames are placeholders for the concrete file the
implementer creates; each implementation PR's CHANGELOG entry cites
the exact filename and one-line purpose.

## 16. Open questions & future slices

- **Slice 2.5 PlatformIdentity merging UI** — manual claim flow,
  OAuth-bound link. The `platformIdentity@1` contract is sized to absorb
  a richer impl without consumer churn.
- **Summarization / compaction** — once cross-channel turn counts grow
  past the 10-turn working set meaningfully, and to make
  forget-with-quote-scrub feasible (§12.3).
- **pgvector semantic recall** —
  `getRelevantByUser(tenantId, userId, queryEmbedding)`.
- **PluginContext metrics accessor** — when added, CCM's plugin-local
  registry migrates.
- **Federation across tenants** for shared workspaces.
- **Reuse of `graphPool@1`** instead of a standalone pool (v1.1
  optimization; KG sets a strong precedent).
- **Per-user encryption keys (BYOK)** for regulated tenants.
- **Score-based decay (v2)** if recency-only suffers in practice.
- **Recycled-email revocation flow** (§4.3 limitation).
- **Multi-tenant per plugin instance** — today single-tenant per
  activate, matching KG; multi-tenant would need per-call enforcement
  and is a separate decision.
- **Unify the two SDK `ConversationTurn` types** — pre-existing
  tech-debt (§7.2). Cleanup-only PR, no consumer impact.
