# Research & Design Decisions: Multi-Orchestrator Runtime

Phase 0 output. Records the design forks that were evaluated and resolved while
shaping this feature, so implementers do not re-litigate them.

## D1 — Isolation model: in-process multi-tenant vs. multi-process

**Decision**: In-process multi-tenant as the runtime model. Each Agent is an
`Orchestrator` instance with its own plugin activations — each plugin activated
against a per-Agent `PluginContext`; all Agents share one Node process. Hard
process isolation is achieved, when needed, by running the
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
`channel_bindings`, `platform_settings`). An optional YAML file is supported
only as a one-time bootstrap seed for an empty database.

**Rationale**: The hard requirement is hot-reload driven by an operator UI
(US9). A UI mutating a checked-in YAML file and then triggering a process
restart contradicts "no infrastructure restart". DB rows give atomic writes, a
natural `LISTEN/NOTIFY` change signal, and multi-machine convergence for free.
The YAML-seed escape hatch keeps first-boot reproducible.

**Rejected**: YAML + file-watcher + graceful restart — still restarts the
process, and a file watcher fights concurrent writes from UI vs. git.

## D3 — Hot-reload mechanism

**Decision**: `OrchestratorRegistry.applyDiff(oldCfg, newCfg)` computes the
minimal patch and applies it in place, using the existing plugin lifecycle
(`activate(ctx)` / `handle.close()`):

- new Agent → construct its `Orchestrator` + `activate` its plugins
- removed Agent → drain sessions, then `close()` its plugin handles
- plugin added → `activate` it against the Agent's `PluginContext`
- plugin removed → `close()` its handle, drop it from the Agent
- plugin config changed → re-activate the plugin (`close()` then `activate`);
  the lifecycle has no in-place `reconfigure`
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
memory scope) stored in `chatSessionStore`. Reload affects only sessions
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

**Decision**: Plugin-capability scoping over the *existing* manifest. An Agent's
visible memory is the union of its enabled plugins' existing `permissions.memory`
declarations plus a shared `core` scope. Writes are tagged with the originating
plugin. No per-record or per-user ACL, and no new manifest field.

**Rationale**: Visibility becomes a set operation (Constitution V): a public
Agent without the Odoo-HR plugin structurally cannot reach Odoo-HR memory — no
call-site auth check to forget. Reusing `permissions.memory` avoids a redundant
parallel `memoryNamespaces` field — plugins already declare their memory
reads/writes there. Tagging by origin lets any Agent with the same plugin share
knowledge without the Agents knowing of each other. `core` is the deliberate
shared floor (operator profile, channel bindings).

**Rejected**: A new `memoryNamespaces` manifest field — redundant with the
`permissions.memory` block plugins already declare. Fine-grained
per-record/per-user ACL — explicitly deferred by the operator; the coarse model
is safe and sufficient for the public/general split.

## D6 — Agent Builder conditioning

**Decision**: The platform already has a plugin lifecycle (`activate(ctx)` /
`handle.close()`) and the Builder already generates `activate`-style plugins
with a `manifest.yaml`. "Conditioning" the Builder for multi-orchestrator is
therefore narrow: once the manifest carries `multiInstance` and `privacyClass`
(US1), the Builder's boilerplate manifests and manifest step must populate them
(US2), and `manifestLinter` validates them.

**Rationale**: There is no new plugin contract to freeze and no plugin
migration to retrofit — the original premise of a "four-check builder-ready
gate" assumed a greenfield contract that does not exist. The only real Builder
work is emitting two new manifest fields, gated by the existing
`manifestLinter`.

**Rejected**: A new lifecycle-contract / no-module-state / dispose-roundtrip
gate — moot once the codebase's existing `activate`/`close` lifecycle is
acknowledged (see the 2026-05-21 re-baseline note in `spec.md`).

## D7 — Where the registry and routing code live

**Decision**: New sub-modules inside `harness-orchestrator`
(`src/registry/`, `src/routing/`), not a new package. No new shared-contract
package is created — `plugin-api` already exists and already holds the plugin
contract (`PluginContext`, the `activate`/`close` lifecycle).

**Rationale**: The registry and router share the orchestrator's lifecycle and
have no independent consumer — a separate package would be organisational-only
(Constitution: no organisational-only libraries). The contract that many
consumers depend on already has its package boundary; this feature extends the
manifest, it does not add a parallel contract package.

## Out of Scope — consumed from elsewhere

- **Knowledge-Graph ownership / ACL**: in progress in a separate worktree
  (`docs/plans/kg-acl-refactor.md`). This feature consumes its scoping output;
  it does not redesign KG visibility. Integration point: the per-Agent scope
  passes the KG visibility key the parallel work defines.
- **Azure AD bot registrations**: operational task; the operator provisions
  distinct bot identities for the public and general bots.

## Clarifications — resolved 2026-05-21

The four open questions were resolved with the operator. Decisions below; the
spec and data model reflect them.

### C1 — `force-invalidate` timing (was Q1; affects US6, FR-014)

**Decision**: Two-tier action — `force-invalidate(agentId, mode)`:

- `mode: 'drain'` (default) — the in-flight LLM turn is allowed to finish, then
  the session is re-bound to the new config. The wait is bounded by the existing
  per-turn LLM timeout; a turn that exceeds it escalates to `kill`, so a hung
  turn cannot block the re-bind indefinitely. The routine "apply now" path.
- `mode: 'kill'` — the session is ended immediately, mid-turn if necessary. The
  security path for a leaked or compromised plugin that must stop serving now.

**Rationale**: The routine case and the security incident are genuinely
different requirements; a single timing policy serves one of them badly. A
`mode` parameter is cheaper than the wrong unified default.

### C2 — unmatched inbound channel key (was Q2; affects US7, FR-015)

**Decision**: A configurable, nullable platform-level `fallbackAgentId`. When
set, an inbound message whose channel key has no binding is routed to that
Agent. When unset, the message is hard-rejected. Either way the event is logged
— never silently dropped.

First-boot onboarding seeds a dedicated minimal-privilege fallback Agent — zero
plugins (a bare LLM agent, valid per US4 AS4) with `privacy_profile = 'strict'`
— and points `fallbackAgentId` at it. This makes the safe configuration the default one and
removes the leak risk of routing unclassified traffic into a full-plugin Agent.
Re-pointing `fallbackAgentId` at a powerful Agent stays possible but is then a
deliberate operator act, not an accident — so no validation guard is required.

**Rejected**: hard-reject-only — bounces every channel until its binding is
created, poor onboarding ergonomics. Mandatory fallback — would force a routing
target even when the operator wants strict rejection.

### C3 — privacy profiles (was Q3; affects US4, US9)

**Decision**: `privacy_profile` stays a two-value enum (`'strict' | 'default'`)
for this feature. The column is modelled so a later migration to a
`privacy_profiles` table (named, operator-extensible profiles) is non-breaking.

**Rationale**: What a profile concretely controls (tokenization aggressiveness,
allowed model providers, redaction rules) is not yet pinned down. Designing an
extensible profile table before the knob set is known is premature; the enum is
sufficient for the public/general split. Extensibility is preserved by storing
the value as `TEXT` + `CHECK` (not a Postgres `ENUM` type), so the migration to
an FK is a dropped constraint, not an `ALTER TYPE`.

**Scope note**: In this feature `privacy_profile` (Agent) and `privacyClass`
(plugin manifest) are *recorded* — stored, schema-validated, operator-set — but
not yet *enforced*: no FR or task derives behaviour from them. They are the data
foundation a later privacy workstream (the Privacy-Proxy effort) consumes.
Implementers must not infer hidden behaviour from these fields here.

### C4 — session store on `force-invalidate` (was Q4; affects US6)

**Decision**: Coupled to C1's `mode`:

- `mode: 'drain'` — the `chatSessionStore` entry is **kept**; only the
  `ConfigSnapshot` is swapped for the new Agent config. Conversation history
  survives.
- `mode: 'kill'` — the `chatSessionStore` entry is **deleted** along with its
  snapshot. The next inbound message starts a fresh session.

**Rationale**: A leaked-plugin purge must not leave that plugin's output sitting
in conversation history; the routine path must not destroy a user's
conversation. The split falls naturally out of the C1 modes.
