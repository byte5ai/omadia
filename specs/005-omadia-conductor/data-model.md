# Data Model: Omadia Conductor

Phase 1 output. Entities, persistent schema, declarative (manifest) schema, and
in-memory runtime structures. DDL is illustrative — final column types/constraints
follow the repo's migration conventions (`middleware/migrations/`). Enums are stored
as `TEXT` + `CHECK` (not Postgres `ENUM`) so the value set can extend without
`ALTER TYPE`, consistent with `specs/001-multi-orchestrator-runtime/data-model.md`.

## Entity Overview

| Entity | Kind | Lifetime |
|---|---|---|
| Workflow | persistent (DB row) | until operator deletes |
| Workflow Version | persistent (DB row, immutable) | retained for audit; runs bind to it |
| Workflow Draft | persistent (DB row, mutable) | editable working copy until published |
| Run | persistent (DB row) | until retention policy prunes |
| Run Step | persistent (DB row) | with its run (durable step record / trace) |
| Await (`conductor_awaits`) | persistent (DB row) | from human step entry to resolve/timeout |
| Await Response | persistent (DB row) | with its await (per-holder, for `quorum: all`) |
| Role | persistent (DB row) | until operator deletes |
| Role Assignment | persistent (DB row) | the baton; until moved/expired |
| Event Catalog Entry | runtime registry (derived from manifests) | per installed connector |
| Conductor Surface | declarative (`manifest.yaml` `emits:`/`provides:`) | versioned with the connector |
| Conductor Engine state | runtime (in-memory, pure) | per step evaluation; no I/O |

## Persistent Schema (Postgres / Neon)

### `conductor_workflows`

The workflow header. The graph itself lives in immutable versions and a mutable draft.

```sql
CREATE TABLE conductor_workflows (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                TEXT NOT NULL UNIQUE,           -- stable id, e.g. "release-signoff"
  name                TEXT NOT NULL,
  description         TEXT,
  status              TEXT NOT NULL DEFAULT 'disabled'-- 'enabled' | 'disabled'
                        CHECK (status IN ('enabled','disabled')),
  active_version_id   UUID,                           -- FK set after first publish
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- `status = 'disabled'` keeps the row but suppresses all triggers (FR-009).
- `active_version_id` is the version new runs bind to; it changes only on publish.

### `conductor_workflow_versions`

An immutable snapshot of the full graph. Runs reference exactly one version (FR-027).

```sql
CREATE TABLE conductor_workflow_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id   UUID NOT NULL REFERENCES conductor_workflows(id) ON DELETE CASCADE,
  version       INT  NOT NULL,                        -- monotonic per workflow
  graph         JSONB NOT NULL,                       -- steps + transitions + triggers (see below)
  published_by  UUID REFERENCES users(id),
  published_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);
```

`graph` shape (validated by `@omadia/conductor-core` before publish):

```jsonc
{
  "entryStepId": "s1",
  "steps": [
    { "id": "s1", "kind": "agent",  "agentId": "...", "postcondition": {...},
      "fallbackTransitionId": "t_fail", "position": { "x": 40, "y": 40 } },
    { "id": "s2", "kind": "human",  "human": { /* see human-step config */ },
      "fallbackTransitionId": "t_deadline" },
    { "id": "s3", "kind": "action", "actionId": "github.create_release" }
  ],
  "transitions": [
    { "id": "t1",       "source": "s1", "target": "s2", "guard": {...} },
    { "id": "t_fail",   "source": "s1", "target": "s_end_fail" },
    { "id": "t_deadline","source": "s2","target": "s_autoreject" }   // in-graph deadline fallback
  ],
  "triggers": [
    { "id": "tr1", "kind": "event", "eventId": "github.pull_request.merged",
      "filter": { "base": "main" } },
    { "id": "tr2", "kind": "manual" }
  ]
}
```

Human-step config (embedded in a `kind: "human"` step):

```jsonc
{
  "principal": { "kind": "role", "ref": "approver.release" },  // or { "kind":"user","ref":"<uuid>" }
  "channel":   "teams",
  "message":   "Release {{ctx.tag}} ready — approve?",
  "reminderInterval": "PT6H",       // ISO-8601 duration; null = no reminders
  "deadline":         "PT24H",      // relative to step entry; null = no deadline
  "quorum":   "any",                // 'any' | 'all' (default 'any')
  "responseSchema": {...}           // shape of the expected decision/input
}
```

### `conductor_workflow_drafts`

The mutable working copy the Designer edits; publishing snapshots it into a version.

```sql
CREATE TABLE conductor_workflow_drafts (
  workflow_id  UUID PRIMARY KEY REFERENCES conductor_workflows(id) ON DELETE CASCADE,
  graph        JSONB NOT NULL DEFAULT '{}',           -- same shape as versions.graph
  base_version INT,                                   -- version this draft was forked from
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `conductor_runs`

A live or completed execution, bound to one immutable version.

```sql
CREATE TABLE conductor_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_version_id UUID NOT NULL REFERENCES conductor_workflow_versions(id),
  status              TEXT NOT NULL DEFAULT 'running' -- 'running'|'waiting'|'completed'|'failed'
                        CHECK (status IN ('running','waiting','completed','failed')),
  current_step_id     TEXT,                           -- node id within the version graph
  context             JSONB NOT NULL DEFAULT '{}',    -- accumulated run context
  trigger_kind        TEXT NOT NULL,                  -- 'manual'|'cron'|'channel'|'agent'|'webhook'|'workflow'|'event'
  trigger_source      JSONB,                          -- e.g. { eventId, sourcePluginId } for event triggers
  is_dry_run          BOOLEAN NOT NULL DEFAULT false,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at            TIMESTAMPTZ
);
CREATE INDEX conductor_runs_waiting_idx ON conductor_runs(status) WHERE status = 'waiting';
```

- `context` is persisted before each step transition (FR-004) so a restart rehydrates
  an accurate run. `is_dry_run` runs never create real awaits or fire connector actions
  (FR-029).

### `conductor_run_steps`

Durable per-step record — both the resume checkpoint (FR-004) and the audit trace
(FR-030). The human-facing view integrates with omadia's existing per-run trace viewer.

```sql
CREATE TABLE conductor_run_steps (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id               UUID NOT NULL REFERENCES conductor_runs(id) ON DELETE CASCADE,
  step_id              TEXT NOT NULL,                 -- node id in the version graph
  seq                  INT  NOT NULL,                 -- order within the run
  actor                JSONB,                         -- { kind:'agent', agentId } | { kind:'human', resolvedUserId } | { kind:'action', actionId }
  postcondition_outcome TEXT,                         -- 'met' | 'unmet' | 'n/a'
  transition_taken     TEXT,                          -- transition id (incl. fallback)
  started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at             TIMESTAMPTZ,
  UNIQUE (run_id, seq)
);
```

### `conductor_awaits`

The durable pending human action — the one genuinely net-new substrate (today
`ask_user_choice` is in-memory and dies on restart). Drives reminders, deadline, and
resume.

```sql
CREATE TABLE conductor_awaits (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                 UUID NOT NULL REFERENCES conductor_runs(id) ON DELETE CASCADE,
  step_id                TEXT NOT NULL,
  principal_kind         TEXT NOT NULL CHECK (principal_kind IN ('user','role')),
  principal_ref          TEXT NOT NULL,               -- user uuid  OR  role key
  channel_type           TEXT NOT NULL,               -- 'teams'|'telegram'|...
  message                TEXT NOT NULL,
  quorum                 TEXT NOT NULL DEFAULT 'any'  CHECK (quorum IN ('any','all')),
  reminder_interval_ms   BIGINT,                      -- null = no reminders
  deadline_at            TIMESTAMPTZ,                 -- null = no deadline
  fallback_transition_id TEXT,                        -- in-graph fallback (required if deadline set)
  status                 TEXT NOT NULL DEFAULT 'waiting'
                           CHECK (status IN ('waiting','resolved','timed_out','cancelled')),
  last_reminder_at       TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at            TIMESTAMPTZ
);
CREATE INDEX conductor_awaits_due_idx ON conductor_awaits(status, deadline_at, last_reminder_at)
  WHERE status = 'waiting';
```

- `principal_ref` holds a **role key**, not a frozen user id, when `principal_kind =
  'role'` — access and reminders re-resolve the current holder (FR-022, FR-023).
- A row with `deadline_at` set MUST carry `fallback_transition_id` (FR-017); enforced in
  validation, not the DB.
- The scheduler polls `conductor_awaits_due_idx`: send a reminder when
  `now ≥ last_reminder_at + reminder_interval_ms`; fire the fallback when
  `now ≥ deadline_at` (reusing the `scheduleWorker` tick).

### `conductor_await_responses`

Per-holder responses, needed for `quorum: all` and for audit.

```sql
CREATE TABLE conductor_await_responses (
  await_id      UUID NOT NULL REFERENCES conductor_awaits(id) ON DELETE CASCADE,
  responder_id  UUID NOT NULL REFERENCES users(id),
  response      JSONB NOT NULL,                       -- the decision/input, shaped by responseSchema
  responded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (await_id, responder_id)
);
```

- `quorum = 'any'`: the first qualifying row resolves the await.
- `quorum = 'all'`: resolved only when every *current* holder (re-resolved at check
  time) has a row — a departed holder's obligation is dropped, a new holder's is added
  (FR-019).

### `conductor_roles`

A named seat addressable by a human step.

```sql
CREATE TABLE conductor_roles (
  key          TEXT PRIMARY KEY,                      -- e.g. "approver.release"
  label        TEXT NOT NULL,
  description  TEXT,
  scope        TEXT,                                  -- optional namespacing/tenant
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `conductor_role_assignments`

The baton — the **default / stand-alone-fallback** holder store, read by the default
`RoleResolver`. **Primary path (#333, Identity & Role Projection):** role holders are
projected from external systems of record (Entra groups/app-roles, HR/ERP) and matched to
users on a primary key; an external resolver registered *in front of* this answers from
that source and ignores this table. The local table is used only when no external source
is configured. (Implementation note: the shipped migration stores `holder_id` /
`delegate_id` as a **session-identity TEXT** — the provider `sub` / email — not a
`users(id)` FK, so holders can be assigned by identity without a users-table join; the
illustrative DDL below predates that — see migration `0003_role_holder_text.sql`.)

```sql
CREATE TABLE conductor_role_assignments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_key      TEXT NOT NULL REFERENCES conductor_roles(key) ON DELETE CASCADE,
  holder_id     UUID NOT NULL REFERENCES users(id),
  provenance    TEXT NOT NULL DEFAULT 'manual',       -- 'manual' | 'resolver:<id>'
  delegate_id   UUID REFERENCES users(id),            -- optional stand-in
  valid_from    TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to      TIMESTAMPTZ,                           -- null = open-ended
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX conductor_role_assignments_role_idx ON conductor_role_assignments(role_key);
```

- Multiple live rows for one `role_key` = a multi-holder role (interacts with `quorum`).
- Moving the baton = closing one assignment (`valid_to = now()`) and opening another;
  this fires `role.assignment.changed` (below).

### Change-notification triggers (run resume + baton moves)

```sql
-- Wake a waiting run when its human responds (US2 resume hook, FR-004).
CREATE OR REPLACE FUNCTION notify_await_resolved() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('resolved','timed_out') AND OLD.status = 'waiting' THEN
    PERFORM pg_notify('conductor_await_resolved', NEW.run_id::text);
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;
-- AFTER UPDATE ON conductor_awaits

-- Emit baton moves for audit + external subscription (FR-025).
CREATE OR REPLACE FUNCTION notify_role_changed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('conductor_role_changed',
                    COALESCE(NEW.role_key, OLD.role_key));
  RETURN NULL;
END; $$ LANGUAGE plpgsql;
-- AFTER INSERT/UPDATE/DELETE ON conductor_role_assignments
```

The kernel runs `LISTEN conductor_await_resolved` and resumes the named run; a periodic
reconcile (scan `conductor_awaits_due_idx` and `status='waiting'` runs) is the fallback
for a dropped `LISTEN` connection, mirroring the multi-orchestrator reconcile (spec 001
D3).

## Declarative Schema — Manifest Extension (the "Conductor Surface")

This feature adds an `emits:` block and an `events` permission to the *existing* plugin
`manifest.yaml` (loaded by `manifestLoader`, validated by `manifestLinter`). It is a
sibling of the existing `provides:` block — no parallel manifest format (FR-010).

```yaml
# in a connector plugin's manifest.yaml
emits:
  - id: github.pull_request.merged          # stable, namespaced event id
    label: "Pull request merged"
    payload_schema:                          # JSON Schema; the Designer reads this
      type: object
      required: [repo, number, base, mergeSha]
      properties:
        repo:     { type: string }
        number:   { type: integer }
        base:     { type: string }
        mergeSha: { type: string }
    schema_version: 1

permissions:
  events:
    emit: [github.pull_request.merged, github.release.created]   # deny-by-default
```

- `provides:` (existing) already enumerates the **actions** a workflow can call back
  into the connector. Together `emits:` + `provides:` are the connector's **Conductor
  Surface** the Designer renders (FR-014).
- Absence of `emits:` is meaningful: the Designer shows the connector exposes no
  Conductor triggers (FR-014).

## Runtime Structures

### `@omadia/conductor-core` (pure engine — no I/O)

- `validate(graph): ValidationResult` — reachability, cycles, deadline-without-fallback,
  unknown references (FR-003).
- `nextStep(graph, currentStepId, stepResult, ctx): Decision` — deterministic
  advancement: postcondition verdict → matching guarded transition → else fallback →
  else `Stuck` error (FR-001, FR-002, FR-006).
- No persistence, scheduling, notification, or LLM calls — those are kernel wiring
  (FR-032). Unit-testable with fixtures exactly like `@omadia/canvas-core`.

### `EventCatalogRegistry` (kernel, via `serviceRegistry`)

Autodiscovered from installed manifests' `emits:` blocks ("declare → resolve → derive",
the canvas-output / deterministic-action pattern). Hot — install adds, uninstall removes
(FR-011). Read by: the Conductor's event subscription router (to start runs) and the
Designer (to offer triggers + payload fields).

### `RoleResolver` registry (kernel, via `serviceRegistry`)

`resolve(roleKey, ctx) → { holders: Principal[]; unavailable?: Principal[]; delegate?: Principal }`.
The **default** resolver reads the local `conductor_role_assignments` table (stand-alone
fallback). The **primary** resolver (#333, Identity & Role Projection) projects holders
from external systems of record (Entra groups/app-roles, HR/ERP) and is registered *in
front of* the default — exactly the "external resolver in front" follow-up the
implementation's `roleStore` already anticipates. Called late — at dispatch and on each
reminder (FR-022).

### `ctx.events.emit(id, payload)` (kernel, gated)

Present only when the manifest declares `permissions.events.emit` (deny-by-default).
Validates `payload` against the catalog's declared schema; rejects + logs a
non-conforming emit; otherwise stamps provenance and routes to subscribed workflows
(FR-012).

## State Machines

### Run

```text
            ┌───────────── (step needs human/timer/event) ─────────────┐
            ▼                                                            │
 (start) running ──(step completes, more steps)──▶ running              │
            │                                        │                   │
            │                                        └──▶ waiting ───────┘   (awaited signal arrives)
            ├──(entry/end step, no more steps)──▶ completed
            └──(step error / stuck-no-fallback)─▶ failed
```

### Await

```text
 (human step entered) waiting
     ├── qualifying response (quorum satisfied) ──▶ resolved   → resume run
     ├── deadline passes, no qualifying response ──▶ timed_out → fire fallback transition
     └── run cancelled/superseded ───────────────▶ cancelled
```

`waiting → {resolved, timed_out}` is atomic (FR-018): the first of {qualifying response,
deadline} wins; the transition emits `conductor_await_resolved`.

## Relationships

```text
conductor_workflows 1───n conductor_workflow_versions   (a workflow has many versions)
conductor_workflows 1───1 conductor_workflow_drafts      (one editable draft)
conductor_workflow_versions 1───n conductor_runs         (a version backs many runs)
conductor_runs 1───n conductor_run_steps                 (a run records its step path)
conductor_runs 1───n conductor_awaits                    (a run may open several human steps)
conductor_awaits 1───n conductor_await_responses         (per-holder responses; quorum)
conductor_roles 1───n conductor_role_assignments         (a role has current holder(s) = the baton)
conductor_awaits n───1 conductor_roles                   (role-addressed await; resolved live)
users 1───n conductor_role_assignments                   (a user may hold several roles)
EventCatalogRegistry ──derives──> connector manifest `emits:`   (runtime, per install)
```

## Validation Rules

- `conductor_workflows.slug`: unique, immutable, URL-safe.
- A published version's `graph`: must pass `@omadia/conductor-core` `validate()` —
  reachable steps, no unguarded cycle, every deadline-bearing human step has a
  `fallbackTransitionId`, every referenced `agentId`/`actionId`/`role`/`eventId` resolves
  (FR-003). Validation runs in the Designer and again on publish/activate.
- `conductor_runs` bind to an immutable `workflow_version_id`; a workflow edit creates a
  new version and never mutates an in-flight run's version (FR-027).
- `conductor_awaits` with `deadline_at` set must carry `fallback_transition_id`.
- An emit is validated against the **installed** connector's declared `payload_schema`
  for that `schema_version`; a non-conforming emit starts no run (FR-012).
- A role-addressed await authorizes read/answer against the role's *current* holders at
  access time; a user who no longer holds the role cannot read or answer it (FR-023).
- A role that resolves to zero available holders makes the human step's postcondition
  unmet → fallback transition fires (FR-024).
- `quorum = 'all'` evaluates the required-holder set at the completion check, re-resolved
  via the `RoleResolver` (not frozen at await creation) (FR-019).
