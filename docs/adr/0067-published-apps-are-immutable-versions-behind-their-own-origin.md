# 0067 — Published apps are immutable versions with a pointer, one data volume per app, and their own origin

## Status

Proposed — the design is implemented and tested in its packages, but the kernel does not mount
`PublishGateway` on main yet (see Consequences). It becomes Accepted when it is wired.

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; issue #581, implemented in #785 (version store, Docker
  runtime, gateway), #786 (`publish` tools), #790 (sharing through grants) and #852 (atomic
  version allocation, fixes #834). Recorded retroactively.
- **Supersedes:** —

## Context and Problem Statement

An agent that can run commands in its sandbox ([ADR-0055](0055-agent-computer-is-a-docker-sandbox-per-scope.md))
can build a small web app there. To be useful the app must keep running after the turn, be
replaceable by a better version, and be reachable by a browser. Agent-written code served from
the operator's own hostname would share its cookies.

This record is retroactive. What is a published app, how does it change, and where is it
served?

## Decision Drivers

- A bad publish must not take down what was live.
- What was published must be reconstructible; nothing overwrites history.
- App data must survive a new version; app code must not.
- An app must never see or set the admin session.
- Changing someone else's app needs a right; a failed lookup must not read as a right.

## Considered Options

- **A — Insert-only versions plus a pointer; a container per version and a volume per app;
  a gateway on a dedicated host suffix; sharing as grants**
- **B — One mutable deployment per app** (overwrite in place)
- **C — Serve apps under a path of the admin host**
- **D — Content-addressed versions** (same bytes, same version)

## Decision Outcome

Chosen option: **A** (`middleware/packages/harness-publish`, `@omadia/publish`).

- **Publish order.** `publish()` reads the directory out of the sandbox (traversal-clamped,
  at most 2,000 files and depth 32), records a new version, deploys it, and only then moves
  the pointer. A failed deploy leaves the version row as evidence and the pointer untouched.
- **Versions are immutable by interface.** `PublishStore` has `createVersion`, `getVersion`,
  `listVersions`, `getPointer`, `setPointer` and no update or delete. Version numbers are
  allocated atomically per `appId` (#852). `rollbackTo` is a pointer flip to an existing
  version and nothing else.
- **Allocation is one statement.** `PostgresPublishStore` allocates the next number with
  `INSERT … ON CONFLICT (app_id) DO UPDATE` on the app's counter row (migration
  `0045_publish_versions.sql`); the primary key `(app_id, version)` is the second line of
  defence. The earlier read-then-insert under `SELECT … FOR UPDATE` was replaced because it
  locks nothing on an app's first publish.
- **No deduplication.** Two publishes of identical bytes get two version numbers; `dirHash`
  (SHA-256 over the tree) is for audit and diffing, not deduplication.
- **The tree is read through the sandbox only.** `collectTree` (`treeCollector.ts`) uses only
  `Sandbox.list` and `Sandbox.read`; a tree over the limits throws `PublishTreeTooLargeError`
  instead of being truncated.
- **Runtime** (`dockerPublishRuntime.ts`): one container per `(appId, version)`, named
  deterministically; `deploy()` for an existing version is a no-op. One Docker volume per
  `appId` is mounted at `/data` (`DATA_DIR`) in every version: files there survive a
  redeploy, everything else is new per version. Image `node:20-alpine`, Node entrypoint only,
  host port assigned by Docker on `127.0.0.1` and read back with `docker port`. Containers
  get the same resource ceilings as sandboxes (`dockerResourceLimitArgs`).
- **Origin boundary** (`publishGateway.ts`). The gateway serves only requests whose `Host`
  ends in a dedicated apps suffix that is never the admin or portal host; it never forwards
  `Cookie` or `Authorization` to an app and strips any `Set-Cookie` with an explicit `Domain=`.
- **Ownership and sharing** (`publishAccess.ts`). The owner is the scope that published
  version 1 and always passes. Any other scope needs a grant in the `GrantStore`
  (`publish:write:<appId>` to redeploy or roll back, `publish:read:<appId>` to use). An unresolved lookup or a
  scope that cannot be turned into a `Principal` is a denial. The first publish of a new
  `appId` establishes ownership and needs no grant.
- **Opt-in.** The tools `publish` and `publish_rollback` are registered only with
  `sandbox_publish_enabled` on the orchestrator plugin, independent of `sandbox_execute_enabled`.
  Store: Postgres when a graph pool is configured, else in memory.

### Consequences

- 🟢 **Good:** Rollback is instant and cannot fail on content; a broken version never becomes
  live.
- 🟢 **Good:** Session theft through an app is closed at the origin, not by trusting app code.
- 🔴 **Bad:** `PublishGateway` is implemented and tested but not mounted by the kernel on
  main (no caller outside the package): published apps listen on a loopback port of the host
  and have no public route yet.
- 🔴 **Bad:** Every version keeps its own container; nothing stops or removes old ones. A
  container that predates the resource limits keeps running without them until a new version
  replaces it.
- 🔴 **Bad:** Only a `personal:<userId>` scope can hold a grant today; non-owner callers on
  conversation, group, org or system scopes are always denied. Role-based grants resolve to
  nothing because `plugin.ts` builds an empty role registry.
- 🔴 **Bad:** Without Postgres the version history is lost on restart while the containers
  keep running.
- ⚪ **Neutral:** `appId` is a lowercase, hyphen-safe slug and doubles as the host prefix.
- 🔴 **Bad:** The gateway enforces only the suffix match (`appsHostSuffix`); choosing a suffix
  that is never the admin or portal host is the deployer's responsibility.
- ⚪ **Neutral:** Docker is the v1 runtime behind the narrow `PublishRuntime` interface
  (`publish.ts`).

## Pros and Cons of the Options

### A — Versions, pointer, per-app volume, own origin

- 🟢 Safe replace and rollback; clear data contract; cookie isolation.
- 🔴 Containers accumulate; needs a wildcard host.

### B — Mutable deployment

- 🟢 One container per app.
- 🔴 A failed publish is an outage; no rollback, no history.

### C — Path on the admin host

- 🟢 No DNS work.
- 🔴 Cookies are scoped by host, not by port or path: the app could read the admin session.

### D — Content-addressed versions

- 🟢 Deduplicates identical publishes.
- 🔴 The record is a log of publish events; identical bytes published twice are two events.

## More Information

- Related: [ADR-0016](0016-least-privilege-and-the-agent-envelope.md);
  [ADR-0055](0055-agent-computer-is-a-docker-sandbox-per-scope.md),
  [ADR-0068](0068-skills-are-scope-owned-with-a-signed-lifecycle.md) (the same "sharing is a grant" rule, with
  the opposite failure default). Border: orchestrator / tools.
- Paths: `middleware/packages/harness-publish/src/`,
  `middleware/packages/harness-orchestrator/src/tools/{publishTool,publishAccess,publishGrantedTools}.ts`,
  `middleware/packages/harness-orchestrator/src/plugin.ts`.
- Tests: `middleware/test/publish/{publish,publishStore,dockerPublishRuntime,publishGateway,treeCollector}.test.ts`,
  `middleware/test/publish/publishStore.pg.test.ts`,
  `middleware/test/sandbox/{publishTool,publishRollbackTool,publishAccess,publishGrantedTools}.test.ts`.
