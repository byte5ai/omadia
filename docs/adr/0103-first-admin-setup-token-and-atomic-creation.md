# 0103 — First-user setup: an operator token in front, exactly one admin behind a table lock

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main);
  implemented in PR #1262 (setup token, atomic creation) and PR #1263 (argon2 capacity).

## Context and Problem Statement

This record is retroactive: it documents a decision that is implemented on main.

A fresh install has no operator, so the first-user wizard (`POST /api/v1/auth/setup`) cannot
sit behind a session. While it is open it is the most valuable endpoint the server has:
whoever completes it becomes the administrator. Two defects existed. Anyone who reached the
port before the operator could complete it, and the handler ran `count()` and a plain
`INSERT` on different connections with an argon2 hash in between, so N parallel requests
produced N admins. How is the wizard authorised, and how is "exactly one first admin"
guaranteed?

## Decision Drivers

- Only the person who operates the deployment may complete setup.
- Exactly one admin, whatever races: parallel wizard requests, two replicas booting with
  the env seed, an OIDC first sign-in.
- No decision may rest on a header the caller writes (`Host`, `X-Forwarded-For`).
- The desktop app must stay zero-configuration.

## Considered Options

- **A — A per-boot setup token checked first; creation in one transaction under a table
  lock.**
- **B — Keep the wizard open, rely on "first come, first served" and network isolation.**
- **C — Env seed only** (`ADMIN_BOOTSTRAP_*`), no wizard.
- **D — `INSERT … WHERE NOT EXISTS`** as the atomicity fix.

## Decision Outcome

Chosen option: **A**.

- **Operator consent.** Before the body is validated the handler compares the `setup_token`
  body field in constant time (SHA-256 of both sides, `timingSafeEqual`) with this boot's
  token (`auth/setupToken.ts`). A miss is `403 auth.setup_token_invalid`. The token is
  `ADMIN_SETUP_TOKEN` (16..512 characters, never logged), else a generated 24-byte base64url
  value stored set-if-absent in `platform_settings` (`auth.setup_token`), printed once per
  boot and deleted in the transaction that creates the first admin. Body only; no header
  spelling.
- **One exemption.** The desktop supervisor starts the kernel with
  `OMADIA_DESKTOP_EMBEDDED=true` and `HOST=127.0.0.1`. Only that pair, decided at boot from
  configuration, opens the wizard without a token. Compose installs get a token: the kernel
  in the container binds `::` and cannot see how its port is published.
- **One predicate.** `resolveSetupState` (`available`, `disabled_at_boot`,
  `no_local_provider`, `locked`) is the only source for `GET /providers.setup_required` and
  for the handler (`410 auth.setup_disabled` / `auth.setup_no_local_provider` /
  `auth.setup_locked`).
- **Exactly one admin.** `UserStore.createFirstAdmin` runs on one connection:
  `SET LOCAL lock_timeout = '2000ms'`, `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`,
  `SELECT COUNT(*)`, then the user insert, the `auth.first_admin_create` audit row and the
  token delete, then commit. The lock conflicts with itself and with every other writer of
  the table, not with readers. The password is hashed before the transaction. A lock wait
  past 2 s answers `409 auth.setup_in_progress`.
- **The env seed uses the same method**, so two replicas booting together seed one admin and
  the loser logs a skip.
- **CPU bound.** The wizard's argon2 hash takes a slot of the sign-in limiter's global
  capacity (`503 auth.busy` beyond it), see
  [ADR-0109](0109-password-sign-in-rate-limiting-pairs-and-device-cookie.md).

### Consequences

- 🟢 **Good:** Reaching the port is no longer enough to own a fresh install.
- 🟢 **Good:** One admin under every race, with its audit row in the same transaction.
- 🔴 **Bad:** A generated token is in the middleware log, and log retention keeps it. It is
  single-use in effect; operators who object set `ADMIN_SETUP_TOKEN`.
- 🔴 **Bad:** Anyone who can read the log or the database can complete setup first. Both
  already imply control of the deployment.
- 🔴 **Bad:** A desktop kernel on loopback accepts the wizard from any local process; the
  local user is the operator in that trust model.
- ⚪ **Neutral:** `SET LOCAL` and a transaction-scoped table lock are compatible with a
  transaction pooler (ADR-0034).

## Pros and Cons of the Options

### A — Token first, table lock

- 🟢 An unauthorised caller cannot make the server validate a body, hash or wait on a lock.
- 🔴 One more value the operator has to copy from a log or set in the environment.

### B — Open wizard

- 🟢 No extra step.
- 🔴 A scanner that finds the port before the operator becomes the administrator.

### C — Env seed only

- 🟢 No public setup endpoint at all.
- 🔴 A password in the environment for every install, including the desktop app.

### D — `INSERT … WHERE NOT EXISTS`

- 🟢 One statement.
- 🔴 Under READ COMMITTED each statement's `NOT EXISTS` runs against a snapshot without the
  other's uncommitted row; two requests both insert.

## More Information

- Code: `middleware/src/auth/setupToken.ts`, `auth/bootstrap.ts`, `auth/userStore.ts`
  (`createFirstAdmin`), `middleware/src/routes/authSetup.ts`, `desktop/src/supervisor.ts`.
- Tests: `middleware/test/auth/{setupRoute,setupToken,userStoreFirstAdmin,bootstrap}.test.ts`,
  `middleware/test/auth/{userStoreFirstAdmin,setupRouteConcurrency}.pg.test.ts`.
- Docs: `docs/security-architecture.md` §10l.
- Related: [ADR-0113](0113-sign-in-providers-behind-one-contract-and-a-single-admin-role.md),
  [ADR-0105](0105-one-api-session-gate-and-a-closed-public-path-list.md), ADR-0034, ADR-0035.
