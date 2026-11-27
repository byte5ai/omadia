# 0184 — Owner-less legacy web chats are given to one account by an audited operator tool

## Status

Accepted

- **Date:** 2026-11-26
- **Deciders:** Owner decision (Marcel, 2026-11-26): on the Fly instance (five accounts) every
  owner-less legacy chat goes to his account. Follow-up to
  [ADR-0180](0180-web-chats-belong-to-the-creating-account.md).
- **Supersedes:** —

## Context and Problem Statement

ADR-0180 gives web chats written before owners existed to the instance's only account, and to
nobody once there are several accounts: they stay on disk under `/memories/chat-sessions/` but
no account lists them. On an instance with several accounts the operator knows whose chats
those were (on Fly: all of them belong to one person), but the API offered no way to say so.
How does an operator hand them to an account without opening a path to other accounts' chats?

## Decision Drivers

- Only chats that have no owner may change; an owned chat never moves.
- The decision is the operator's, recorded in the admin audit trail before anything changes.
- Repeatable and previewable: a dry run first, then the real run; running it twice changes
  nothing the second time.
- The owner stamped must be the key the chat routes compare (the session's `sub`).

## Considered Options

- **A — An admin route `POST /api/v1/admin/chats/assign-orphans { userId, dryRun? }`.**
- **B — A one-off script against the store.**
- **C — Let the first account that opens a legacy chat claim it.**

## Decision Outcome

Chosen option: **A**.

- **Route.** `POST /api/v1/admin/chats/assign-orphans`, behind `requireAuth` (every account is
  an administrator, `adminUsers.ts`). Body `{ userId: <users.id>, dryRun?: boolean }`.
- **Owner key.** The account's `providerUserId`: the session `sub` the chat routes compare
  (ADR-0180; for local accounts the lower-cased e-mail, for Entra the IdP subject). The route
  resolves it from `users`; an unknown account answers 404, a disabled one 409.
- **Only orphans.** `ChatSessionStore.assignOrphans` stamps chats without `ownerUserId`, each
  under its session lock; unreadable files are counted (`unreadable`) and left as they are.
- **Dry run** answers `{ wouldAssign, unreadable }` and changes nothing.
- **Audit first.** A real run writes `admin_audit` action `chat.assign_orphans`, target
  `user:<users.id>`, actor `auditActorFromRequest` (`users.id`), `after: { owner, count }`, and
  changes nothing when that write fails or no audit log is wired.

### Consequences

- 🟢 **Good:** Multi-account instances get their legacy chats back for the right person,
  reviewable in the audit trail.
- 🔴 **Bad:** All orphans go to one account; an instance whose legacy chats belong to several
  people cannot split them with this tool.
- ⚪ **Neutral:** On Fly the lander runs it after the deploy of ADR-0180, first as a dry run.

## Pros and Cons of the Options

### A — Admin route

- 🟢 Audited, previewable, idempotent, reachable on every deployment.
- 🔴 One more admin route.

### B — Script

- 🟢 No API surface.
- 🔴 No audit row; needs shell access to the instance.

### C — First opener claims

- 🟢 No operator step.
- 🔴 Hands another person's chat to whoever looks first.

## More Information

- Code: `middleware/src/routes/adminChats.ts`, `ChatSessionStore.assignOrphans`
  (`harness-orchestrator/src/chatSessionStore.ts`), audit action in `src/auth/adminAuditLog.ts`.
- Tests: `middleware/test/adminChatsAssignOrphans.test.ts`.
- Related: [ADR-0180](0180-web-chats-belong-to-the-creating-account.md), ADR-0120 (audit first).
