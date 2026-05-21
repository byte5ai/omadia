# Data Model: Multi-Orchestrator Runtime

Phase 1 output. Entities, persistent schema, and in-memory runtime structures.
DDL is illustrative — final column types/constraints follow the repo's
migration conventions (`middleware/migrations/`).

## Entity Overview

| Entity | Kind | Lifetime |
|---|---|---|
| Agent | persistent (DB row) | until operator deletes |
| Agent–Plugin Assignment | persistent (DB row) | until plugin removed from Agent |
| Channel Binding | persistent (DB row) | until rebound/removed |
| Platform Settings | persistent (DB row) | single row, process-wide |
| Plugin Manifest | declarative (file in plugin) | versioned with the plugin |
| Plugin Scope | runtime (in-memory) | per (Agent × plugin), until reload/dispose |
| Config Snapshot | runtime (session store) | per session, until session ends |
| Memory Namespace | logical partition | implicit, defined by manifests |

## Persistent Schema (Postgres / Neon)

### `agents`

The orchestrator instance.

```sql
CREATE TABLE agents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT NOT NULL UNIQUE,          -- stable identifier, e.g. "public"
  name            TEXT NOT NULL,                 -- display name
  description     TEXT,
  privacy_profile TEXT NOT NULL DEFAULT 'default'-- 'strict' | 'default'
                    CHECK (privacy_profile IN ('strict','default')),
  status          TEXT NOT NULL DEFAULT 'enabled'-- 'enabled' | 'disabled'
                    CHECK (status IN ('enabled','disabled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- `slug` is the routing/log identifier and is immutable after creation.
- `status = 'disabled'` keeps the row but removes the Agent from the registry.
- `privacy_profile` is stored as `TEXT` + `CHECK` deliberately, not a Postgres
  `ENUM` type (C3): extending the value set or migrating to a future
  `privacy_profiles` FK table then means dropping one `CHECK`, not an
  `ALTER TYPE`.

### `agent_plugins`

Which plugins an Agent runs, plus per-Agent plugin configuration.

```sql
CREATE TABLE agent_plugins (
  agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  plugin_id   TEXT NOT NULL,                  -- manifest plugin id
  config      JSONB NOT NULL DEFAULT '{}',    -- validated against plugin config schema
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, plugin_id)
);
```

- `config` is opaque to the registry; the plugin validates it in `init`.
- An Agent with no rows here is a valid bare LLM agent.

### `channel_bindings`

Maps an inbound channel address to the owning Agent.

```sql
CREATE TABLE channel_bindings (
  channel_type TEXT NOT NULL,                 -- 'teams' | 'telegram' | ...
  channel_key  TEXT NOT NULL,                 -- bot id / conversation id / handle
  agent_id     UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_type, channel_key)     -- a channel key binds to exactly ONE Agent
);
CREATE INDEX channel_bindings_agent_idx ON channel_bindings(agent_id);
```

- The composite PK enforces FR-016: one channel key cannot bind to two Agents.

### `platform_settings`

Process-wide settings not owned by any single Agent. A single-row table.

```sql
CREATE TABLE platform_settings (
  id                BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),  -- single row
  fallback_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- `fallback_agent_id` is the C2 unmatched-channel-key target. `NULL` ⇒ unmatched
  keys are hard-rejected; set ⇒ they route to that Agent. `ON DELETE SET NULL`
  degrades safely to hard-reject if the fallback Agent is deleted.
- First-boot onboarding seeds a minimal-privilege fallback Agent (zero plugins,
  `strict` profile) and sets this column to it (C2; FR-021).
- A change here emits `agents_changed` via a dedicated trigger (payload: the
  literal `platform`) so every machine's channel resolver reloads the fallback
  target.

### Change-notification trigger

```sql
CREATE OR REPLACE FUNCTION notify_agents_changed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('agents_changed', COALESCE(NEW.agent_id, OLD.agent_id)::text);
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

-- attach AFTER INSERT/UPDATE/DELETE on agents, agent_plugins, channel_bindings
```

Every Fly machine runs `LISTEN agents_changed`; on notification the registry
runs `applyDiff`. A periodic reconcile (re-read all three tables) is the
fallback for a dropped `LISTEN` connection (D3).

## Declarative Schema — Extended Plugin Manifest

New required fields on `PluginManifest` (full TypeScript + JSON Schema in
`contracts/plugin-lifecycle.md`):

| Field | Type | Meaning |
|---|---|---|
| `multiInstance` | `boolean` | May the plugin run as >1 instance in one process? Default `true`. |
| `multiInstanceJustification` | `string` | Required when `multiInstance` is `false`; why it cannot. |
| `memoryNamespaces` | `string[]` | Memory partitions this plugin contributes; `[]` ⇒ uses only `core`. |
| `requiredCapabilities` | `string[]` | Capabilities the plugin needs from a scope, e.g. `"llm:chat"`, `"kg:read"`. |
| `privacyClass` | `'strict' \| 'default'` | Plugin's data-handling class; the Builder defaults generated plugins to `strict`. |

## Runtime Structures (in-memory)

### `PluginScope`

The per-(Agent × plugin) container. One Agent has one scope **per enabled
plugin**; the Agent's overall context is the set of its scopes.

- `agentId`, `pluginId`
- `services` — capability-keyed service resolver (`services.get('llm:chat')`)
- `disposables` — registry of teardown handles flushed by `dispose`
- `config` — the validated per-Agent plugin config
- `logger` — pre-bound with `agentId` + `pluginId` context

### `ConfigSnapshot`

Immutable, captured at session start, stored on the `chatSessionStore` record:

- `agentId`
- `pluginIds: string[]` + `pluginVersions: Record<string,string>`
- `toolIds: string[]`
- `memoryNamespaces: string[]`

The session uses this snapshot for its entire lifetime; reload never mutates it
(D4). `force-invalidate` is the only operation that touches it: in `drain` mode
it swaps the snapshot for the current Agent config and keeps the session-store
entry; in `kill` mode it deletes the snapshot and the entire session-store
entry (C1/C4).

## Relationships

```text
agents 1───n agent_plugins        (an Agent enables many plugins)
agents 1───n channel_bindings     (an Agent owns many channel keys)
agents 1───n PluginScope          (runtime: one scope per enabled plugin)
agents 1───n session/ConfigSnapshot (runtime: many live sessions)
agents 0..1─1 platform_settings   (an Agent may be the fallback target)
PluginManifest 1───n agent_plugins (one manifest, enabled on many Agents)
```

## Validation Rules

- `agents.slug`: unique, immutable, URL-safe.
- `channel_bindings`: `(channel_type, channel_key)` globally unique (FR-016).
- `agent_plugins.config`: validated against the plugin's config schema at
  `init`; an invalid config fails the Agent's load for that plugin only,
  logged, without taking down the Agent or its other plugins.
- A plugin with `multiInstance: false` may appear in `agent_plugins` for at
  most one `agent_id`; the registry rejects a second assignment at `applyDiff`.
- `requiredCapabilities`: every entry must be satisfiable by the scope the
  registry builds for that Agent; an unsatisfiable capability fails that
  plugin's load with a precise error.
- `platform_settings.fallback_agent_id`, when set, should reference an `enabled`
  Agent; if it resolves to a disabled or missing Agent the router treats
  unmatched channel keys as hard-rejected (degraded-safe).
