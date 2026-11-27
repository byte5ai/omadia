# 0262 — A user purge covers every linked channel identity and ends the person's web sessions

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** W31 cluster lead (wave 6 autonomy grant)
- **Supersedes:** — (closes two residuals of [ADR-0186](0186-user-purge-erases-one-person.md))

## Context and Problem Statement

ADR-0186 lets one purge erase a person resolved from an omadia user id, an account id or a
channel identity. It left two gaps: the per-channel context trees
`/memories/contexts/<agent>/user/<kind>~<id>` of the person's *other* identities needed one
purge per identity (#2293), and an open web session kept the deleted omadia user id through
every renewal until a real sign-in, so new turns, datasets and processes carried a dead id
(#2292). Should the purge reach both itself, or should operators follow a documented order
(purge each identity, then delete the account)?

## Decision Drivers

- An erasure the operator runs once must be complete; an order to remember is not.
- Sessions are revoked by `users.session_version` (ADR-0106); nothing new is needed.
- The identity links are deleted by the purge itself, so they must be read before.

## Considered Options

- **A — The purge resolves all linked identities up front and revokes the accounts' sessions.**
- **B — Document "purge every identity, then delete the account" as the only order.**

## Decision Outcome

Chosen option: **A**.

- **Identities.** `KnowledgeGraph.listUserChannelIdentities?` (plugin-api 1.108.0, kernel-only
  in the bounded graph services; in-memory and Neon) lists the `ChannelIdentity` nodes of the
  person's `User` cluster. `planPurge` (`routes/memoryPurge.ts`) adds the context trees of
  every `<kind>~<id>` to the scratch targets, so preview and delete count and remove them in
  the same run. The list is read during planning, before the identity step deletes the links.
- **Sessions.** The `web` identities name the person's accounts (`users.id`). After every other
  layer, the purge calls `revokeAccountSessions` (composition root: `UserStore.update(id,
  { revokeSessions: true })`), which bumps `session_version`; every open session of those
  accounts answers `401 auth.revoked` on its next request. Preview and result report the
  accounts (`sessionAccountCount`, `sessionsRevoked`; audit `planned/deleted.sessionsRevoked`).
  Without a user store the preview warns `sessions_not_revoked`.
- Account deletion stays a separate act (ADR-0186); the account row is not touched beyond the
  version bump.

### Consequences

- 🟢 **Good:** One purge by any of the person's ids removes all their context trees and ends
  their sessions; a later sign-in creates a new cluster cleanly.
- 🟢 **Good:** The audit row records the accounts whose sessions ended.
- 🔴 **Bad:** An identity that was never linked to the cluster (no shared verified e-mail, no
  kernel link per ADR-0225) is still a separate person and needs its own purge.
- 🔴 **Bad:** Ending the sessions also signs the person out of the admin UI if they are the
  operator running the purge on themselves.

## Pros and Cons of the Options

### A — Resolve and revoke in the purge

- 🟢 Complete in one run; reuses existing revocation.
- 🔴 One more optional KG method.

### B — Document the order

- 🟢 No code.
- 🔴 Leaves erasure to operator discipline; context keys of other identities are not shown
  anywhere an operator could copy them from.

## More Information

Issues #2292, #2293; ADR-0106, ADR-0120, ADR-0186, ADR-0225.
