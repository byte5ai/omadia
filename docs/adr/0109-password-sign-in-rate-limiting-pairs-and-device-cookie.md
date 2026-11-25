# 0109 — Password sign-in limiting: per (account, client) pairs, a device cookie, no account lock

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main);
  implemented in PR #1263, one failure code in #1311, failure audit in #1315.

## Context and Problem Statement

This record is retroactive: it documents a decision that is implemented on main.

`POST /api/v1/auth/login/:providerId` is public, and every well-formed attempt costs a full
argon2id verification (19 MiB, t=2), an unknown address included. Nothing counted attempts:
anyone who reached the route could guess passwords without limit and drive unbounded argon2
work. The textbook answer, locking the account after N failures, hands an attacker a tool:
on a single-admin install a few wrong passwords lock out the only person who could unlock
it. And in every shipped topology the kernel sees one TCP peer for all browsers (the web-ui
proxy), so "per IP" means "everyone". How is guessing bounded without building a lock-out
weapon?

## Decision Drivers

- Bound online guessing against one account and the CPU an anonymous sender can burn.
- An anonymous sender must not be able to lock the real operator out.
- The client key must not be something the client can choose.
- No new infrastructure (Redis) for a single-replica deployment.
- A refusal must not reveal whether a password was right.

## Considered Options

- **A — Three layers (client brake, per-pair backoff, global argon2 capacity) with a device
  cookie for known browsers; in memory, per process.**
- **B — Per-account lockout after N failures.**
- **C — Per-IP limiting on `req.ip`.**
- **D — A shared limiter in Redis or Postgres.**

## Decision Outcome

Chosen option: **A** (`auth/loginRateLimiter.ts`, wired in `routes/authLogin.ts` before
`provider.verify`).

- **Three kinds of client key.** `device` (the browser holds a genuine device cookie for
  this account), `address` (an address a trusted hop vouched for) and `shared` (the TCP
  peer). `AUTH_LOGIN_CLIENT_ADDRESS` chooses the source: `socket` (default), `xff:<n>`
  counted from the right, or `header:<name>` set by the edge. The limiter never reads
  `req.ip`.
- **Client layer** (`address` keys only): a leaky bucket of failures, burst 100, then one
  every 6 s; full → `429 auth.rate_limited`. A `shared` key skips it, because braking the
  proxy's address would let any sender lock out every browser of the deployment.
- **Account layer**, per (account, client) pair: five free failures, then
  1 s × 2^(failures − 5) after the last failure, capped at 2 minutes; a success clears the
  pair; it is forgotten after 30 minutes. A client only ever slows down its own attempts.
- **Global layer**: at most `AUTH_LOGIN_MAX_INFLIGHT` (default 4) verifications at once and
  300 admitted attempts per minute; over it → `503 auth.busy`. One slot and 60 of the 300
  are headroom only `device` attempts can take.
- **Device cookie** (`omadia_login_device`, the OWASP device-cookie pattern). Minted only by
  a successful password sign-in (and the first-user wizard), bound by HMAC to the verified
  account and to the credential epoch that sign-in checked, valid one year, surviving
  logout. All device cookies of one account count as one client.
- **The account key folds further than the database.** `loginAccountKey` applies NFKD,
  drops combining marks, lower-cases and folds dotless ı and final ς, so every spelling the
  users table's `LOWER()` treats as one account is one key. `LocalPasswordProvider` signs in
  only to an account whose stored address folds to the key the attempt was counted under.
- **Counting at admission.** A pending attempt counts as a failure, so N parallel requests
  cannot all pass before the first verdict.
- **One failure code.** Every failure that did not prove the password answers
  `invalid_credentials` after one argon2 verify (a dummy hash on a miss); `user_disabled`
  is returned only behind a correct password.
- **Observability.** The first refusal per scope and client per minute writes one
  `auth.login_rate_limited` audit row, the first failure per pair per minute one
  `auth.login_failed` row. Neither records typed text.

### Consequences

- 🟢 **Good:** About 30 guesses per hour per client against one account; argon2 work is capped.
- 🟢 **Good:** A browser that signed in before keeps a path in, however hard others push.
- 🔴 **Bad:** In memory and per process: a restart clears every counter, and N replicas
  multiply every ceiling by N. A restart is also the documented out-of-band unlock.
- 🔴 **Bad:** Clients on one key share its pairs: under `socket` every browser without a
  device cookie can be kept at the 2-minute wait on one account by one persistent sender.
- 🔴 **Bad:** Distributed guessing across many client keys is bounded only by the global
  layer; a wrong `xff:<n>` lets a client choose its key.
- ⚪ **Neutral:** Thresholds are constants in the module; only the address policy, the IPv6
  prefix (`AUTH_LOGIN_IPV6_PREFIX`) and the in-flight cap are configuration.

## Pros and Cons of the Options

### A — Layers, pairs, device cookie

- 🟢 No lock an anonymous sender can close on someone else.
- 🔴 Considerably more mechanism, and residuals that need documenting.

### B — Account lockout

- 🟢 Simple and strict.
- 🔴 A denial-of-service primitive against the only admin, whose unlock path it denies.

### C — Per-IP on `req.ip`

- 🟢 One line with a library.
- 🔴 `req.ip` is client-chosen under a trusted hop, else the proxy's address for everyone.

### D — Shared limiter

- 🟢 Correct ceilings across replicas.
- 🔴 A new dependency for a deployment that runs one middleware machine.

## More Information

- Code: `middleware/src/auth/{loginRateLimiter,loginAccount,loginDevices,loginDeviceCookie,clientAddress,loginFailureAudit}.ts`,
  `middleware/src/routes/authLogin.ts`.
- Tests: `middleware/test/auth/{loginRateLimiter,loginRateLimiterFairness,loginLockoutDos,loginDevices,loginDeviceRevocation,loginAccount,clientAddress,loginFailureAudit}.test.ts`,
  `middleware/test/auth/loginAccountFold.pg.test.ts`.
- Docs: `docs/security-architecture.md` §10m.
- Related: [ADR-0111](0111-request-trust-boundary-named-proxies-and-declared-scheme.md),
  [ADR-0103](0103-first-admin-setup-token-and-atomic-creation.md),
  [ADR-0101](0101-api-keys-as-second-authentication-method.md) (same per-process trade-off).
