# Cross-Channel Conversation Memory

| | |
|---|---|
| **Status** | Proposed |
| **Capabilities** | `platformIdentity@1`, `crossChannelConversationMemory@1` |
| **Plugins (provider candidates)** | `@omadia/platform-identity-neon`, `@omadia/platform-identity-inmemory`, `@omadia/cross-channel-conversation-memory-neon`, `@omadia/cross-channel-conversation-memory-inmemory` |
| **Owners** | omadia-middleware (providers); omadia-ui Tier-2 orchestrator (first consumer); channel-plugin maintainers (write path) |
| **Depends on** | `plugin-api` PluginContext, `harness-channel-sdk` ConversationHistoryStore contract, `harness-plugin-privacy-guard` (soft) |

## 1. Context & Motivation

**Scenario.** A user researches on Telegram during the morning commute,
then opens the omadia-ui desktop app at the office. The Tier-2
orchestrator in omadia-ui materializes the prior context across channels
for seamless continuity. omadia-ui CONCEPT.md v0.7 declares a hard
`requires: ['chatAgent@1', 'memoryStore@1', 'crossChannelConversationMemory@1']`
and treats cross-channel memory as an omadia-core responsibility.

**Today's state in omadia main.**

- `ConversationHistoryStore`
  (`middleware/packages/harness-channel-sdk/src/stores.ts`):
  `get(scope)`, `append(scope, turn)`, optional `clear(scope)`.
- `InMemoryConversationHistoryStore`
  (`middleware/packages/harness-channel-sdk/src/inMemoryConversationHistory.ts`):
  10 turns per scope, 2h TTL, 500 scopes LRU, in-process volatile.
- `ChannelUserRef` (`incoming.ts`): `{kind, id, displayName?, email?}`
  with closed-union `kind`. `PlatformIdentity` is platform-local
  (`platformId = "${kind}:${id}"`); no cross-channel resolution today.
- Scope = channel-native identifier (Teams thread id, Slack channel +
  thread tuple, Telegram chat id). Not user-scoped.
- Privacy redaction (`egressWalker` + `harness-plugin-privacy-guard`)
  runs on egress, after the chat agent produces a result. Redaction
  does not touch persistence today.
- `SessionLogger` writes markdown transcripts to `MemoryStore` at
  `/memories/sessions/<scope>/YYYY-MM-DD.md`. Different code path; stays
  untouched by this RFC.
- Slice 2.5 (cross-channel identity merging) is on the roadmap, not yet
  implemented.

**Why a capability, not per-channel ad hoc.** Five channel plugins would
each have to re-implement identity binding, durable storage, retention,
tenant isolation, GDPR delete. A single shared capability concentrates
that one place. omadia-ui has already taken the dependency.

**Why now.** omadia-ui-orchestrator cannot ship without it. The
"S-Bahn → office" continuity is the headline UX promise of the desktop
app.

## 2. Non-goals for v1

- Multi-platform account claiming UI (Slice 2.5 owns this; v1 ships the
  data model only).
- Summarization or compaction of older turns.
- Semantic or vector recall — no pgvector. Recency plus per-user filter
  is the only retrieval axis in v1.
- HOT / WARM / COLD tiering or score-based decay analogous to
  `harness-knowledge-graph-neon`. CCM is chronological; value fades
  naturally with time. v2 path open.
- Cross-tenant sharing or team memory.
- Replacing or merging `SessionLogger`'s markdown transcript path.

## 3. Capability split — two capabilities, four plugins

The RFC introduces **two capabilities**, deliberately separated:

- `platformIdentity@1` — resolves `ChannelUserRef → stable userId`,
  manages identity merges, handles GDPR forget. Slice 2.5 will replace
  this capability's implementation with a fully-fledged identity
  service; the contract is sized so the swap is mechanical for
  consumers.
- `crossChannelConversationMemory@1` — append-only durable conversation
  log keyed by `(tenantId, userId, channel, createdAt)`. Requires
  `platformIdentity@1`.

Each capability ships with a **Neon backend plus in-memory sibling**
pair, mirroring `@omadia/knowledge-graph-neon` /
`@omadia/knowledge-graph-inmemory`:

- `@omadia/platform-identity-neon` + `@omadia/platform-identity-inmemory`
- `@omadia/cross-channel-conversation-memory-neon` +
  `@omadia/cross-channel-conversation-memory-inmemory`

Mutual exclusion per capability — `installed.json` must contain at most
one provider per capability. Operators pick Neon for production,
in-memory for CI / smoke / local-dev. Specifying both Neon variants at
once is rejected by the kernel resolver. Specifying both capabilities
together is the point: it forces the contract to stay backend-agnostic,
because Postgres semantics cannot leak into the interface if a Map-based
sibling is required to satisfy the same tests.

### Pragmatic fallback

If the v1 boilerplate of four packages is excessive, a v1.0 may collapse
both capabilities into one plugin per backend —
`@omadia/platform-memory-neon` and `@omadia/platform-memory-inmemory` —
each publishing both capabilities (`platformIdentity@1` +
`crossChannelConversationMemory@1`). Pattern precedent:
`@omadia/knowledge-graph-neon` already publishes six capabilities
(`knowledgeGraph@1`, `entityRefBus@1`, `graphPool@1`, `graphLifecycle@1`,
`agentPriorities@1`, `processMemory@1`) — see its `manifest.yaml`. The
capabilities stay separate as contracts; only the packaging collapses.
Slice 2.5 reverses the collapse with zero consumer churn.

**Default in this RFC: keep the four packages, accept the boilerplate,
get cleaner ownership boundaries.**

## 4. Identity model v1 — `platformIdentity@1`

### Goal

Stable, opaque `userId` (ULID) that one `ChannelUserRef` maps to
deterministically. Multiple ChannelUserRefs across different channel
kinds can resolve to the same `userId`.

### Auto-derivation rule

- Incoming `ChannelUserRef.email` matches an existing `platform_identities`
  row's `email` → attach the same `userId`.
- Otherwise → mint a new `userId`.

This handles Teams (AAD email always present) and Slack with the
`users:read.email` scope without explicit linking.

### No-email fallback (Telegram, WhatsApp)

Each `platformId` gets its own `userId` until a manual claim happens. A
future tenant-admin UI emits a "merge claim" event; out of scope to
build the UI in v1, in scope to make the mapping table mutable via
`mergeIdentities(primary, secondary)`.

### Capability surface

```ts
interface PlatformIdentityCapability {
  resolveUserId(
    tenantId: string,
    ref: ChannelUserRef,
  ): Promise<{ userId: string; isNew: boolean }>;

  mergeIdentities(
    tenantId: string,
    primaryUserId: string,
    secondaryUserId: string,
    source: 'manual' | 'system',
  ): Promise<{ mergedRows: number }>;

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

### Schema — `platform_identities`

```
tenant_id      TEXT        NOT NULL
platform_id    TEXT        NOT NULL    -- "${kind}:${id}"
user_id        TEXT        NOT NULL    -- ULID
kind           TEXT        NOT NULL    -- ChannelUserRef.kind
channel_id     TEXT        NOT NULL    -- ChannelUserRef.id
display_name   TEXT        NULL
email          TEXT        NULL
first_seen_at  TIMESTAMPTZ NOT NULL
last_seen_at   TIMESTAMPTZ NOT NULL
claim_source   TEXT        NOT NULL    -- 'auto-email' | 'manual' | 'system'

PRIMARY KEY (tenant_id, platform_id)
INDEX        (tenant_id, email) WHERE email IS NOT NULL
INDEX        (tenant_id, user_id)
```

### Resolution site

The channel plugin calls `resolveUserId(tenantId, ref)` at ingress,
before calling `append()`. The resolved `userId` rides on the harness
session context (`ctx.user.id`, a new field on `TurnContextValue`,
populated by the channel adapter) and on every subsequent `appendTurn`
write.

## 5. Storage backend (Neon variant) — `crossChannelConversationMemory@1`

Postgres only, no pgvector for v1. Connection pool, migrations, tenant
isolation mirror `@omadia/knowledge-graph-neon` exactly.

### Wiring

- Pool: `createNeonPool(ctx.secrets.get('database_url'))` (pattern from
  `harness-knowledge-graph-neon/src/plugin.ts` activate body).
- Migrations: file-based `.sql` under
  `middleware/packages/harness-cross-channel-conversation-memory-neon/src/migrations/`,
  tracked in a `_ccm_migrations` table, applied in a transaction
  (pattern from `harness-knowledge-graph-neon/src/migrator.ts`).
- If `database_url` is missing the plugin publishes no capability and
  fails fast — mirrors the KG plugin's "no-op handle, downstream
  consumers degrade" behavior.

### Schema — `cross_channel_messages`

```
id                  TEXT        NOT NULL   -- ULID, sortable
tenant_id           TEXT        NOT NULL
user_id             TEXT        NOT NULL   -- from platformIdentity@1
channel_kind        TEXT        NOT NULL   -- 'teams-aad' | 'slack-user' | ...
channel_scope       TEXT        NOT NULL   -- native channel scope id
canvas_session_id   TEXT        NULL       -- omadia-ui canvas correlation
user_message        TEXT        NOT NULL   -- raw, never redacted at write
assistant_answer    TEXT        NOT NULL   -- raw, never redacted at write
tool_calls          JSONB       NULL
metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb
redaction_metadata  JSONB       NULL       -- populated by async hook (§8)
created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
expires_at          TIMESTAMPTZ NOT NULL   -- created_at + tenant TTL

PRIMARY KEY (id)
INDEX (tenant_id, user_id, created_at DESC)
INDEX (tenant_id, channel_scope, created_at DESC)
INDEX (tenant_id, expires_at)
```

### Quotas — `ccm_user_quotas`

```
tenant_id   TEXT        NOT NULL
user_id     TEXT        NOT NULL
turn_count  BIGINT      NOT NULL DEFAULT 0
byte_count  BIGINT      NOT NULL DEFAULT 0
updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()

PRIMARY KEY (tenant_id, user_id)
```

Counters are updated in the same transaction as the `INSERT` into
`cross_channel_messages`. No scans on the hot path.

## 6. Capability API — `crossChannelConversationMemory@1`

```ts
interface CrossChannelConversationMemoryCapability {
  appendTurn(args: {
    tenantId: string;
    userId: string;              // resolved upstream via platformIdentity@1
    channelKind: string;
    channelScope: string;
    canvasSessionId?: string;
    turn: ConversationTurn;      // { userMessage, assistantAnswer, timestampMs? }
    toolCalls?: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<{ messageId: string }>;

  getRecentByUser(
    tenantId: string,
    userId: string,
    opts: {
      limit: number;             // hard-cap 100
      sinceMs?: number;          // epoch ms; default = no lower bound
      excludeCanvasSessionId?: string;
      channelKinds?: string[];   // optional filter
      includeRaw?: boolean;      // admin-only; default false → redacted
    },
  ): Promise<CrossChannelTurn[]>;

  // Compat shim for today's ConversationHistoryStore.get() contract.
  getByChannelScope(
    tenantId: string,
    channelScope: string,
    limit: number,
  ): Promise<ConversationTurn[]>;

  forgetByUser(
    tenantId: string,
    userId: string,
  ): Promise<{ deletedTurns: number }>;
}

interface CrossChannelTurn extends ConversationTurn {
  id: string;
  channelKind: string;
  channelScope: string;
  canvasSessionId?: string;
  toolCalls?: unknown;
  metadata: Record<string, unknown>;
  createdAtMs: number;
}
```

### Relation to existing store

The `ConversationHistoryStore` interface (`stores.ts`) stays unchanged.
The new capability is **durable backing**.
`InMemoryConversationHistoryStore` stays alive as a per-channel hot
cache — the 10-turn read path stays fast and offline-tolerant. The
bridge is the new `DurableConversationHistoryStore` adapter (§7).

## 7. Write path & adapter

### New adapter

`DurableConversationHistoryStore` in
`middleware/packages/harness-channel-sdk/src/durableConversationHistory.ts`
implements `ConversationHistoryStore` and fans out:

- `append(scope, turn)`:
  1. delegate to an inner `InMemoryConversationHistoryStore` (existing
     ring-buffer semantics, unchanged),
  2. async `crossChannelConversationMemory.appendTurn(...)`
     fire-and-forget; errors logged via `ctx.notifications` and a
     bounded outbox.
- `get(scope)`:
  1. inner in-memory store first;
  2. on cold start (empty bucket), hydrate from
     `getByChannelScope(tenantId, scope, limit)`.

Latency stays on the in-memory path. Durable write is best-effort; the
hot turn never blocks.

### Capability discovery and graceful degradation

The adapter calls `ctx.services.get('crossChannelConversationMemory@1')`
at construction. If the capability is not registered (CI / dev / Neon
plugin absent), the adapter behaves exactly like
`InMemoryConversationHistoryStore`. No breaking change.

### Channels opt in per PR

Each of `harness-channel-teams`, `harness-channel-slack`,
`harness-channel-telegram`, `harness-channel-web-chat` replaces its
`new InMemoryConversationHistoryStore()` call site with
`new DurableConversationHistoryStore(...)` in its own PR. Channel teams
review independently. Roll-back is per-channel.

## 8. Privacy & redaction

### Decision

**Persist the raw turn.** Egress-redaction (`egressWalker` → privacy
service → `applyEgressReplacements`) keeps holding for outbound traffic;
the existing pipeline does not change.

### Rationale

Egress PII filters are tuned for trimming user-facing text. Redacting on
persist would silently corrupt continuity ("you mentioned Vendor X
yesterday" fails when X was scrubbed). Storage fidelity is not the same
problem as presentation fidelity.

### Pre-persist redaction hook (optional, per-tenant)

A tenant configuration flag `ccm_redact_on_persist` (default `false`)
makes the adapter run an inline pass through
`harness-plugin-privacy-guard` before append. Strict-compliance tenants
set it to `true` and accept the continuity cost.

### Async redaction metadata (default mode)

A scheduled job populates `redaction_metadata` (span offsets and tags)
asynchronously by walking new rows through the privacy guard. Reads
default to redacted-projection — mask spans tagged in
`redaction_metadata` on the fly. The `includeRaw: true` flag is
admin-only and tenant-scoped; each raw read is audit-logged via
`ctx.notifications`.

### GDPR

`forgetUser(tenantId, userId)` on `platformIdentity@1` and
`forgetByUser(tenantId, userId)` on `crossChannelConversationMemory@1`
run in a single transaction at the right-to-erasure flow. Quotas are
zeroed. No tombstone row remains.

## 9. Consumer inventory

### Primary

**omadia-ui Tier-2 orchestrator** — reads `getRecentByUser` at
turn-start, writes through `DurableConversationHistoryStore` after each
turn. Mechanics in §10.

### Plausible next consumers (no commitment in v1)

- **search-agent** — read-only, recent turns inform query expansion and
  disambiguation across channels.
- **knowledge-graph reference-agents** — read-only, entity grounding
  ("user already discussed Vendor X yesterday on Telegram").
- **builder-ui** — read-only, "what was I working on" panel across
  sessions and devices.

### Out of scope as consumer in v1

- `SessionLogger` keeps its markdown transcript path.
- `QualityGuard` has no cross-channel signal need.

Consumers discover the capability via
`ctx.services.get('crossChannelConversationMemory@1')`. Absence degrades
gracefully — empty arrays, no error.

## 10. Primary consumer mechanics — omadia-ui Tier-2 orchestrator

### Pipeline placement

```
turn-start
  ├─ resolve userId  (already on ctx.user.id, populated by channel adapter)
  ├─ READ : crossChannelConversationMemory.getRecentByUser(tenantId, userId, {...})
  ├─ build prompt  (system + cross-channel summary block + current session turns + user message)
  ├─ chatAgent.invoke(prompt)
  ├─ WRITE: DurableConversationHistoryStore.append(scope, turn)
  │           → fans out to capability appendTurn(tenantId, userId, ...)
turn-end
```

### userId resolution

The orchestrator does not synthesize a `ChannelUserRef`. The channel
plugin has already called
`platformIdentity@1.resolveUserId(tenantId, ref)` at ingress and
attached `userId` to `ctx.user.id` (a new field on the harness session
context, populated by the channel adapter). The orchestrator reads
`ctx.user.id` and `ctx.tenantId`.

If `ctx.user.id` is missing (very first ingress, ever), the orchestrator
skips the read step and proceeds with empty cross-channel context. The
write step still happens — the first `appendTurn` pins the identity.

### Read call (turn-start)

```ts
const recent = await ccm.getRecentByUser(tenantId, ctx.user.id, {
  limit: 20,
  sinceMs: Date.now() - 3 * 24 * 60 * 60 * 1000,   // 3-day window
  excludeCanvasSessionId: ctx.canvasSessionId,      // skip current session
  // channelKinds omitted: include all channels
});
```

The orchestrator does **not** inject these verbatim into the LLM
context. It builds a compact summary block — a bullet list of
`{ channelKind, relativeAge, role, content_truncated_200_chars }` for
the top 8 by recency, prepended to the system prompt under
`## Recent context from other channels`. This caps cross-channel
injection at ~2 KB regardless of history depth.

### Write call (turn-end)

Through the adapter, no direct capability call from the orchestrator:

```ts
await durableStore.append(scope, { userMessage, assistantAnswer, timestampMs });
```

The adapter resolves `tenantId` and `userId` from the harness context
and calls
`crossChannelConversationMemory.appendTurn({ ..., toolCalls, metadata: { canvasSessionId } })`
asynchronously. The orchestrator never blocks on this.

### Relevance strategy

Last 20 turns within 3 days, scoped to the same `userId` across all
channels, current canvas-session excluded. Sorted by recency only.
Semantic relevance is explicitly out of scope for v1.

### Failure mode

Capability missing, throws, or returns empty: orchestrator logs `warn`
once per session with `{ userId, reason }`, proceeds with empty
cross-channel context, **does not block the turn**. The write side is
already best-effort by adapter design. A counter
`ccm_write_failures_total` is incremented for ops visibility.

## 11. Cross-tenant isolation

- `tenant_id TEXT NOT NULL` on every table. No `DEFAULT 'default'` —
  stricter than KG's `0001_graph_init.sql`.
- Every query binds `WHERE tenant_id = $1` at the capability impl layer,
  not at the consumer.
- `tenantId` resolved from `ctx.config.get('ccm_tenant_id')` at
  `activate()` time, mirrors KG's `graph_tenant_id` resolution.
- **Fail-closed:** if `tenantId` is missing from any call context, the
  capability throws. No silent default. No admin override.
- Application-level isolation, not RLS — same operational model as KG.

## 12. Capacity & lifecycle

### Defaults (all configurable via `ctx.config`)

- `ccm_ttl_days` = 90 (per-turn TTL).
- `ccm_user_msg_cap` = 10000 (per-user hard cap on `turn_count`).
- `ccm_gc_cron` = `"0 4 * * *"` (daily 04:00 UTC).
- `ccm_gc_interval_minutes` = empty (cron is used by default).

### Single job — `ccm-gc`

Cron or interval, `overlap: 'skip'`. Two passes per sweep:

1. Delete rows where `expires_at < now()`.
2. For each `(tenant_id, user_id)` with `turn_count > ccm_user_msg_cap`,
   delete the oldest excess rows.

No score-decay table. No HOT / WARM / COLD tiering. Chronological log;
value fades with time. v2 path to score-decay stays open.

## 13. Plugin manifests

### `@omadia/cross-channel-conversation-memory-neon` (sketch)

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

### `@omadia/platform-identity-neon` (sketch)

Same shape with `provides: ["platformIdentity@1"]`, no `requires`, its
own `setup.fields` for `database_url` and `pi_tenant_id`.

In-memory siblings: identical manifests with `id` / `name` swapped, no
`database_url` field, same `provides:`, no `integrations`. Mutual
exclusion handled by the kernel's single-provider-per-capability rule.

## 14. PR sequence

All PRs additive, none breaking. Each from a `feat/...` or `docs/...`
feature branch per AGENTS.md ("Niemals direkt auf `main` pushen").
Conventional commits, subject < 70 chars. CHANGELOG entry on every PR.

| # | PR title (conventional commit) | Adds / changes | Unblocks |
|---|---|---|---|
| 1 | `docs(rfc): cross-channel conversation memory + platform identity` | This RFC, `middleware-agent-handoff.md` Roadmap bullet, CHANGELOG entry | Contract frozen for Codex review |
| 2 | `feat(harness-platform-identity-*): provide platformIdentity@1 (neon + inmemory)` | Two new packages, manifests, migrations (`_pi_migrations`, `platform_identities`), full impl | CCM plugin has a `requires:` target |
| 3 | `feat(harness-cross-channel-conversation-memory-*): provide crossChannelConversationMemory@1 (neon + inmemory)` | Two new packages, migrations (`_ccm_migrations`, `cross_channel_messages`, `ccm_user_quotas`), full impl, `ccm-gc` job | Channels can opt in |
| 4 | `feat(harness-channel-sdk): DurableConversationHistoryStore adapter` | New file `durableConversationHistory.ts`, capability-aware fallback to InMemory | Channel rollouts |
| 5 | `feat(harness-channel-teams): opt into DurableConversationHistoryStore` | Swap store construction site | Teams cross-channel reads |
| 6 | `feat(harness-channel-slack): opt into DurableConversationHistoryStore` | " | Slack cross-channel reads |
| 7 | `feat(harness-channel-telegram): opt into DurableConversationHistoryStore` | " | Telegram cross-channel reads |
| 8 | `feat(harness-channel-web-chat): opt into DurableConversationHistoryStore` | " | Web-chat cross-channel reads |
| 9 | `feat(orchestrator): consume crossChannelConversationMemory@1` *(in omadia-ui repo)* | Read-at-turn-start, summary block, write via adapter | S-Bahn → office scenario |

Each PR is independently mergeable. PR 1 is **docs-only** and lands
first to lock the contract for Codex review. End-to-end verification of
the capability happens at PR 3 and PR 9.

## 15. Open questions & future slices

- **Slice 2.5 PlatformIdentity merging** — manual claim UI, OAuth-bound
  link flow. The `platformIdentity@1` contract is sized to absorb a
  richer impl without consumer churn.
- **Summarization / compaction** — once cross-channel turn counts grow
  past the 10-turn working set meaningfully.
- **pgvector semantic recall** —
  `getRelevantByUser(tenantId, userId, queryEmbedding)`.
- **Federation across tenants** for shared workspaces.
- **Reuse of `graphPool@1`** instead of a standalone pool (v1.1
  optimization; KG sets a strong precedent).
- **Per-user encryption keys (BYOK)** for regulated tenants.
- **Score-based decay (v2)** if recency-only suffers in practice.
