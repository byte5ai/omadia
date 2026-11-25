# 0045 — A topic is content of every member: cluster per owner set, show only to full readers

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** Maintainers, from issue #1851 (found by the canary sweep of PR #2225,
  memory-ACL plan step 3); implemented in PR #2235, accepted 2026-11-25. Owner decision of 2026-11-24
  ("private knowledge always stays private", ADR 0040), asserted by
  `middleware/test/memoryAccess/oracle.ts` (`readsEveryMember`).

## Context and Problem Statement

Re-clustering on `/admin/topics` grouped every memorable-knowledge entry of the tenant by
embedding similarity, whoever owned it, and wrote each cluster's name and description from
up to five member summaries (by the model, or verbatim as a fallback). The Privacy Shield
masked the summaries on the way out and restored the real values into what was stored.
`GET /api/v1/admin/topics` then returned every topic to every account. The detail route
filtered the members per viewer, but the topic's name and description stayed visible, so
account B read contract dates and fees from account A's private entries (#1851).

Memorable knowledge is owner-gated even between administrators (`acl_owners`, ADR 0040;
least privilege, ADR 0016; information flow, ADR 0019). A topic label is derived content
of its members. Where may topic formation and topic reads cross that gate?

## Decision Drivers

- No text derived from a memory may reach someone who cannot read that memory, whichever
  route carries it — including model output and fallbacks.
- `/admin/topics` must stay useful for shared knowledge, not only for private entries.
- ACLs change after a re-cluster (share, unshare, delete); the read side must not trust the
  state the topic was built from.
- No schema migration and no second clustering service.

## Considered Options

- **A — Cluster per exact owner set, and gate reads on every member.**
- **B — Keep tenant-wide clustering, gate only reads** (a topic is shown when the viewer
  reads every member).
- **C — Keep tenant-wide clustering, redact name/description for partial readers.**
- **D — Cluster per viewer at read time.**

## Decision Outcome

Chosen option: **A**.

- **The rule.** A topic's name, description and member count are content of every member.
  A viewer sees a topic only when they pass the per-MK gate (`acl_owners` contains them)
  for every current member, and the topic has at least one. Otherwise `list` leaves it
  out and `getWithMembers` returns `null` (HTTP 404, as for an unknown id). A topic whose
  live member count no longer matches its stored `member_count` (a member was deleted or
  purged) is hidden from everyone until the next re-cluster, because its text still carries
  the gone member's summary.
- **Formation.** `recluster` splits the entries by their exact, deduplicated owner set and
  clusters each set on its own. Entries without owners are readable by no one, get no
  topic and count as unclustered. One Privacy Shield run per owner set, so a restore can
  only hand back values from that set's own summaries.
- **Contract.** `TopicClusteringService.list(viewerOmadiaUserId)` takes the viewer
  (`@omadia/plugin-api` 1.97.0); `GET /api/v1/admin/topics` passes the session user.

### Consequences

- 🟢 **Good:** the #1851 leak is closed on both sides: no topic mixes owners, and a topic
  that predates the rule or whose ACL changed is hidden from anyone missing a member.
- 🟢 **Good:** the canary sweep asserts it (`canaryHttp.test.ts`); the `todo` and the
  `security-architecture.md` residual are gone.
- 🔴 **Bad:** entries Alice owns alone and entries she shares with Bob never share a topic,
  although Alice could read both. Topics are coarser for people with many owner sets.
- 🔴 **Bad:** `list` reads the members of every topic (one query per topic). Topics are
  few and operator-triggered; acceptable until it shows up.
- 🔴 **Bad:** `list` checks `acl_owners` on the member rows itself, while the detail route
  goes through `getMemorableKnowledge(id, viewer)`. Both are the owner gate today; the Neon
  sweep (`canaryHttp.pg.test.ts`) requires the two routes to return the same topics for
  every viewer, so a gate that changes on one side turns it red.
- 🔴 **Bad:** deleting one memory hides its whole topic until someone re-clusters.
- ⚪ **Neutral:** existing mixed topics stay in the database until the next re-cluster, but
  the read gate already hides them from everyone who misses a member.
- ⚪ **Neutral:** the raw dev graph overlay (`GET /api/dev/graph/topics`) takes no viewer,
  like the rest of the operator-only graph browser; `POST /api/v1/admin/topics/recluster`
  stays open to every account, since every account is an administrator today.
- ⚪ **Neutral:** `list(viewerOmadiaUserId)` makes the parameter required, which breaks a
  caller of `topicClustering@1` that passes none. Released as a minor (1.97.0): the kernel
  route is the only caller, and an optional viewer would reopen the leak.

## Pros and Cons of the Options

### A — Cluster per owner set, gate reads

- 🟢 Every topic has a defined audience (its owner set) that can see it.
- 🔴 No topic across owner sets, even where one reader could see all of them.

### B — Gate reads only

- 🟢 Smallest change.
- 🔴 A mixed cluster is visible to no one, or only to people who own everything: shared
  topics disappear, and the cross-owner summaries still went into one model call.

### C — Redact for partial readers

- 🔴 The name is a single string; there is no safe partial view of model output that was
  written from all members at once.

### D — Cluster per viewer at read time

- 🟢 Ideal recall per person.
- 🔴 Model calls on every page view, per viewer; topics are no longer stored nodes the
  dev graph and HAS_TOPIC edges rely on.

## More Information

- Code: `middleware/packages/harness-orchestrator-extras/src/topicClustering.ts`,
  `middleware/src/routes/topics.ts`, `middleware/packages/plugin-api/src/topic.ts`.
- Tests: `middleware/test/slice11TopicCluster.test.ts` (owner partition, read gate,
  pre-rule mixed topics), `middleware/test/memoryAccess/canaryHttp.test.ts`.
- Related: [ADR 0016](0016-least-privilege-and-the-agent-envelope.md),
  [ADR 0019](0019-discretion-as-information-flow-control.md),
  [ADR 0039](0039-memory-access-verified-by-oracle-and-canary-sweep.md),
  [ADR 0040](0040-one-graph-read-boundary-per-turn.md),
  [ADR 0044](0044-plugins-read-the-graph-through-bounded-services.md) (topic graph methods are
  `kernel-only` for plugins).
- The duplicates queues (`/api/v1/admin/duplicates`) already filter per viewer; the same
  sweep found them clean, so they are not part of this decision.
