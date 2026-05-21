# Research & Design Decisions: Multi-Orchestrator Runtime

Phase 0 output. Records the design forks that were evaluated and resolved while
shaping this feature, so implementers do not re-litigate them.

## D1 — Isolation model: in-process multi-tenant vs. multi-process

**Decision**: In-process multi-tenant as the runtime model. Each Agent is an
`Orchestrator` instance with its own `PluginScope` set; all Agents share one
Node process. Hard process isolation is achieved, when needed, by running the
**same codebase** as separate Fly apps with different config — not by a
different code path.

**Rationale**: The codebase already centres on one process; in-process
multi-tenancy reuses the event loop, HTTP server, and DB pool. Multi-process
would multiply Fly machines and CI surface for no code-level benefit. The
public/general split's trust boundary is satisfied by either model; where a
hard OS boundary is genuinely wanted (e.g. a public-facing Agent), the operator
deploys a second Fly app from the same image. One code path, two deployment
shapes.

**Rejected**: Per-Agent child processes / worker threads — adds IPC, lifecycle,
and crash-supervision complexity disproportionate to the single-digit Agent
count.

## D2 — Configuration storage: YAML file vs. database

**Decision**: Postgres-backed configuration (`agents`, `agent_plugins`,
`channel_bindings`). An optional YAML file is supported only as a one-time
bootstrap seed for an empty database.

**Rationale**: The hard requirement is hot-reload driven by an operator UI
(US9). A UI mutating a checked-in YAML file and then triggering a process
restart contradicts "no infrastructure restart". DB rows give atomic writes, a
natural `LISTEN/NOTIFY` change signal, and multi-machine convergence for free.
The YAML-seed escape hatch keeps first-boot reproducible.

**Rejected**: YAML + file-watcher + graceful restart — still restarts the
process, and a file watcher fights concurrent writes from UI vs. git.

## D3 — Hot-reload mechanism

**Decision**: `OrchestratorRegistry.applyDiff(oldCfg, newCfg)` computes the
minimal patch and applies it in place:

- new Agent → construct + `init` its scopes
- removed Agent → drain sessions, then `dispose` its scopes
- plugin added → `scope.attach(plugin)` → `plugin.init(scope)`
- plugin removed → `plugin.dispose()`, drop the scope entry
- plugin config changed → `plugin.reconfigure(...)` if supported, else
  dispose + re-init
- channel binding changed → atomic swap in the resolver map

HTTP routes stay process-static; the channel resolver consults the live
registry per request, so no Express bind/unbind is needed. The change signal is
Postgres `LISTEN/NOTIFY` on an `agents_changed` channel; a periodic reconcile
re-reads config as a safety net for missed notifications.

**Rationale**: A diff/patch keeps unrelated Agents untouched (zero downtime). A
request-time resolver avoids the hardest part — re-binding live HTTP listeners.
`LISTEN/NOTIFY` propagates across all Fly machines without bespoke messaging.

**Rejected**: Full registry rebuild on every change — disrupts every Agent.
Re-binding HTTP routes per Agent — fragile, and unnecessary given a resolver.

## D4 — Protecting in-flight sessions

**Decision**: Session-snapshot pinning. At session start, the session captures
an immutable `configSnapshot` (Agent id, plugin set + versions, tool ids,
memory namespaces) stored in `chatSessionStore`. Reload affects only sessions
started afterwards. An explicit `force-invalidate` operator action ends and
re-binds an Agent's existing sessions when an immediate change is required.

**Rationale**: An LLM turn must not see its tool list, plugin set, or memory
scope change mid-conversation — that produces hallucination against a stale
schema. Pinning makes "reload affects new sessions only" a guarantee, not a
hope. `force-invalidate` covers the rare case where stale config must be purged
now (e.g. a leaked plugin must stop serving immediately).

**Rejected**: Live-migrating running sessions onto the new scope — semantically
unsound mid-turn and far more complex than pinning.

## D5 — Memory visibility model

**Decision**: Plugin-capability scoping. Each plugin declares
`memoryNamespaces` in its manifest. An Agent's visible namespaces =
⋃(enabled plugins' namespaces) ∪ `{core}`. Writes are tagged with the
originating plugin. No per-record or per-user ACL.

**Rationale**: Visibility becomes a set operation (Constitution V): a public
Agent without the Odoo-HR plugin structurally cannot reach `odoo-hr` memory —
no call-site auth check to forget. Tagging by origin lets any Agent with the
same plugin share knowledge without the Agents knowing of each other. `core` is
the deliberate shared floor (operator profile, channel bindings).

**Rejected for now**: Fine-grained per-record/per-user ACL — explicitly
deferred by the operator; the coarse model is safe and sufficient for the
public/general split.

## D6 — Agent Builder conditioning timing

**Decision**: Freeze the `plugin-api` contract (US1) and re-point the Builder
at it (US2) before any other work. The Builder enforces a four-check
builder-ready gate: lifecycle-contract (tsc against `plugin-api`),
no-module-state (custom ESLint rule), dispose-roundtrip (vitest), manifest
schema (JSON Schema validator).

**Rationale**: The Builder runs in a parallel worktree and keeps emitting
plugins. Every plugin generated against the old singleton model is debt that
must be retrofitted. Freezing the contract first makes new Builder output
correct by construction.

**Rejected**: Migrate Builder output later — guarantees a growing retrofit
backlog.

## D7 — Where the registry and routing code live

**Decision**: New sub-modules inside `harness-orchestrator`
(`src/registry/`, `src/routing/`), not a new package. `plugin-api` *is* a new
package boundary.

**Rationale**: The registry and router share the orchestrator's lifecycle and
have no independent consumer — a separate package would be organisational-only
(Constitution: no organisational-only libraries). The lifecycle contract, by
contrast, has many consumers (every plugin, the Builder, the registry) and must
be a hard package boundary so no consumer can re-declare it.

## Out of Scope — consumed from elsewhere

- **Knowledge-Graph ownership / ACL**: in progress in a separate worktree
  (`docs/plans/kg-acl-refactor.md`). This feature consumes its scoping output;
  it does not redesign KG visibility. Integration point: the per-Agent scope
  passes the KG visibility key the parallel work defines.
- **Azure AD bot registrations**: operational task; the operator provisions
  distinct bot identities for the public and general bots.

## Open Questions for `/speckit-clarify`

- **Q1**: Target window for `force-invalidate` — end sessions immediately, or
  drain with a grace period? (Affects US6.)
- **Q2**: Default route for an unmatched inbound channel key — hard reject vs. a
  configurable fallback Agent? (Affects US7/FR-015.)
- **Q3**: Privacy profiles — is `strict` vs. `default` sufficient, or is a
  named/extensible profile set needed? (Affects US4/US9.)
- **Q4**: Session TTL interaction — does `force-invalidate` also clear the
  session store entry, or only re-bind the snapshot? (Affects US6.)
