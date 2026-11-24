# 0034 — No session-scoped Postgres state on the shared pool; a notification is only a hint

## Status

Accepted

- **Date:** 2026-11-20
- **Deciders:** Maintainers, after the facilitator plugin's lock defect during the native
  facilitator rollout (#2043); PRs #2106 and #2134.

## Context and Problem Statement

Production reaches Postgres through Neon's transaction-mode pooler. Consecutive statements of
one client may run on different server sessions, and a server session may be shared by
several clients. The facilitator plugin's session-level advisory lock showed what follows:
lock and unlock ran on different server sessions, and the lock stayed on a session nobody
owned.

An audit of the kernel found the same construct elsewhere: `pg_try_advisory_lock` /
`pg_advisory_unlock` in all eight SQL migrators; `LISTEN` in `ReloadBus` for message
subscriptions (the statement succeeds, no notification ever arrives); and advisory locks held
across several transactions in two knowledge-graph vector operations.

A second audit (#2134) looked at the other side of `LISTEN`. Postgres has no privilege for
`NOTIFY`: every role that can log in, an archetype plugin's database role included, can send
on the channels the kernel listens on, with any payload. The kernel logged that payload in
full and reloaded on every notification.

What may kernel code rely on from a pooled connection, and what may it take from a
notification?

## Decision Drivers

- The kernel must behave the same behind PgBouncer or Neon's pooler as on a direct
  connection.
- Plugins have their own database roles (ADR-0022, K3); nothing they can send may steer the
  kernel.
- Two machines booting at once must still apply each migration exactly once.

## Considered Options

- **A — Transaction-scoped state only on the shared pool; a direct connection where session
  state is unavoidable; notifications carry no data the kernel trusts.**
- **B — Require a direct (session-mode) connection for the whole kernel.**
- **C — Keep session locks and detect leaked ones with timeouts.**

## Decision Outcome

Chosen option: **A**.

- **Shared pool:** only `pg_advisory_xact_lock` and `SET LOCAL`, inside a transaction. No
  session-level advisory lock, plain `SET`, `SET ROLE`, temp table, named prepared statement
  or cursor across transactions.
- **Migrators:** each pending file is applied in its own transaction that sets a bounded
  `lock_timeout`, takes `pg_advisory_xact_lock(ns, key)` and re-reads the ledger for that file
  under the lock. Same lock keys and budget as before; the steady-state boot takes no lock.
- **Session state that cannot be avoided** gets its own direct connection: `ReloadBus` opens a
  `pg.Client` for `LISTEN`, and the knowledge-graph vector operations use
  `connectForSession(pool)`. The address is `DATABASE_URL_DIRECT` when set, else a Neon
  `-pooler` host without `-pooler`, else the URL as it is.
- **A notification is a hint.** No listener reads the payload to decide anything; state is read
  from the tables. The payload is not logged (one line per reload with a count; an optional
  debug sink gets channel and size). Notifications within 250 ms of a reload
  (`minNotifyIntervalMs`, monotonic clock) are answered by one reload at the end of the
  interval; the last one is never dropped.
- Execution scopes, reservations, kill switches and grants use no notification at all; they are
  read at every authorization.

### Consequences

- 🟢 **Good:** Migrations, subscriptions and vector maintenance work behind a transaction
  pooler; no lock is left on a server session nobody owns.
- 🟢 **Good:** A forged or flooded notification changes nothing and writes nothing to the log.
- 🔴 **Bad:** `LISTEN` and the vector operations need a second, direct address; a pooler that
  cannot be recognised from its address needs `DATABASE_URL_DIRECT`.
- 🔴 **Bad:** A second real change within 250 ms reaches other machines up to 250 ms later.
- ⚪ **Neutral:** Not run through a real PgBouncer; the pooled behaviour is taken from
  PgBouncer's and Neon's documentation. Plugin code is expected to follow the same rule; no guard
  checks it.

## Pros and Cons of the Options

### A — Transaction-scoped state, direct connection by exception, hints only

- 🟢 Keeps the pooler's connection economy for ordinary queries.
- 🔴 Every new use of session state has to be recognised in review.

### B — Direct connection for everything

- 🟢 No rule to remember.
- 🔴 Gives up pooling on Neon, where direct connections are scarce.

### C — Session locks with leak detection

- 🟢 Smallest change.
- 🔴 Two machines that share a server session both acquire the lock; detection comes after
  the damage.

## More Information

- Tests: `migratorConcurrentBoot.test.ts`, `migratorXactLock.pg.test.ts`,
  `reloadBusListen.pg.test.ts`, `pooledDatabaseSessionState.test.ts`,
  `reloadBusNotifyHint.test.ts`, `facilitatorContractGuards.pg.test.ts`.
- Docs: `docs/security-architecture.md` §8a-1.
- Related: ADR-0022 (schema-limited plugin database roles).
