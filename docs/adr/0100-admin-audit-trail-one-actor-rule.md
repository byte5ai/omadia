# 0100 — The admin audit trail: append-only, one actor rule, written by the kernel

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main). The
  table is OB-50; the actor rule and the read route are #1315 (PR #1415), after #775;
  consent history #1347; plugin-written rows #1327–#1329 (PR #1425).

## Context and Problem Statement

This record is retroactive: it documents a decision that is implemented on main.

`admin_audit` started as a ledger for user and provider administration. As more features
wrote to it, each one named its actor differently: the session's `sub` (an e-mail for local
accounts, which made the `uuid` column's INSERT fail and lost the row, #775), the
knowledge-graph user id, a value from the request body, a free-form system label. "What did
user X do?" had no single query. omadia has one role, so the trail is the only control
between administrators. What may be written to it, by whom, with which actor, and who reads
it?

## Decision Drivers

- "Everything user X did" must be one filter.
- An actor must never come from data the caller controls.
- A plugin must not be able to forge a kernel event.
- No secret, token, hash or password in a row.
- An audit failure must not undo or hide an action that already happened, except where the
  row is the point.

## Considered Options

- **A — One generic append-only table, a single actor helper keyed on `users.id`, a closed
  action vocabulary, kernel-mediated plugin writes.**
- **B — One audit table per feature.**
- **C — Free-form actor strings.**
- **D — A tamper-evident chain for admin actions** (as receipts have).

## Decision Outcome

Chosen option: **A** (`auth/adminAuditLog.ts`, auth migration `0002_admin_audit.sql`).

- **Shape.** `actor_id` (uuid, nullable), `actor_email`, `action`, `target`, `before`,
  `after` (JSONB), `created_at`. Nothing in the code updates or deletes a row.
- **The actor rule.** A row written on behalf of a signed-in user takes its actor from
  `auditActorFromRequest(req)`: `actor_id` is the session's `uid` claim (`users.id`),
  `actor_email` the session's e-mail. Never the request body, never `sub`, never
  `omadia_user_id`. A `uid` that is not a uuid is dropped, not stored.
- **Other writers.** A writer that only holds a label uses `auditActorFromLabel`: a uuid goes
  to `actor_id`, anything else to `actor_email`. A kernel job uses
  `systemAuditActor('system:<name>')`. Rows with no person behind them (sign-in refusals and
  failures, the env-seeded first admin) carry no actor.
- **Closed vocabulary.** `AuditAction` is a TypeScript union of dotted verbs
  (`user.*`, `auth.*`, `plugin.*`, `registry.*`, `agent.*`, `trigger.*`, `conductor.*`,
  `privacy.*`, `api_key.*`, `memory.purge`, …). Adding an event means extending the type.
- **Plugins write through the kernel.** `PLUGIN_AUDIT_POLICY` admits an action only for
  named plugins and a target shape (`api_key.*` → `@omadia/channel-api`, target
  `api-key:<uuid>`). The plugin id comes from the kernel's per-plugin wrapper
  (`scopeOperatorAuthToPlugin`), is stamped into `before.plugin` / `after.plugin`, and each
  payload is capped at 4 KB. The actor comes from the kernel's session evaluation.
- **Payload rule.** `before`/`after` are built from the stored, non-secret view, never from
  the request body; a failed sign-in names the account only as the `users` row it resolves
  to, so a password typed into the e-mail field stays out.
- **Ordering.** Where the row is the guarantee it comes first or in the same transaction:
  `auth.session_renew` is written before the cookie is set, `auth.first_admin_create` in the
  transaction that creates the user. Elsewhere the write is best-effort and loud: a failure
  is logged as an error and the action stands.
- **Reading.** `GET /api/v1/admin/audit` behind the session gate; filters `action` and
  `actor_id` are validated against a closed pattern and bound as parameters. Every signed-in
  user can read it, the same population that can already administer everything.

### Consequences

- 🟢 **Good:** `actor_id = X` answers "everything user X did" across every feature.
- 🟢 **Good:** A system name or an e-mail can no longer make an INSERT fail and lose the row.
- 🔴 **Bad:** The trail lives in the database the administrators reach. It is evidence
  against mistakes and for review, not tamper-proof against an operator with database
  access.
- 🔴 **Bad:** Best-effort writes mean an action can exist without its row when the database
  write fails after the action.
- 🔴 **Bad:** A token minted before the `uid` claim yields an e-mail and no `actor_id`.
- 🔴 **Bad:** No retention or export policy is defined for the table.
- ⚪ **Neutral:** Other ledgers stay separate by design: the API-key usage log, the Conductor
  run events and the receipt chain answer different questions.

## Pros and Cons of the Options

### A — One table, one actor helper, kernel-mediated

- 🟢 One query surface; the rule is a function, not a convention.
- 🔴 `before`/`after` are free JSON; consistency per action is by review.

### B — Per-feature tables

- 🟢 Typed columns per event.
- 🔴 "What did X do last week" becomes a union over every feature.

### C — Free-form actors

- 🟢 Nothing to resolve.
- 🔴 The state before #1315: four namespaces in one column and lost rows (#775).

### D — Hash chain

- 🟢 Tamper evidence.
- 🔴 Serialises every admin write and needs anchoring to mean anything; not built.

## More Information

- Code: `middleware/src/auth/adminAuditLog.ts`, `auth/operatorAuthAccessor.ts`,
  `auth/loginFailureAudit.ts`, `middleware/src/routes/adminAudit.ts`,
  `middleware/src/auth/migrations/0002_admin_audit.sql`.
- Tests: `middleware/test/auth/{adminAuditRoute,operatorAuthAudit,loginFailureAudit}.test.ts`,
  `middleware/test/roleChangeAudit775.pg.test.ts`, `test/webhookChangeAudit1707.test.ts`.
- Docs: `docs/security-architecture.md` §10q (audit trail), §9 (plugin audit policy).
- Related: ADR-0041 (webhook administration rows), ADR-0016 (broad-reach grants are
  audited), [ADR-0113](0113-sign-in-providers-behind-one-contract-and-a-single-admin-role.md),
  [ADR-0106](0106-operator-sessions-stateless-jwt-with-server-side-revocation.md).
