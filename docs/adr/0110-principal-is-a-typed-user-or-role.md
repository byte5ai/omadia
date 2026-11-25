# 0110 — `Principal` is a typed `user` or `role`, canonicalised per kind; it says who, never what they may do

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); issue
  #333 phase 1 (PR #724), on the boundary set by
  `specs/575-scope-and-identity-foundation/spec.md` §6.

## Context and Problem Statement

This record is retroactive: it documents a decision that is implemented on main.

"Who is this decision about" existed only inside the Conductor: two loose columns
(`principal_kind IN ('user', 'role')`, `principal_ref`) and a canonicaliser that returned a
bare string. Grants, credential ownership, approvals and the audience floor all needed to
name a person or a role, and nothing outside the Conductor could. Two issues were about to
build it twice: #333 (identity) and #575 (scopes and grants). What is the platform's typed
answer to "who", where does it live, and where does identity stop and permission start?

## Decision Drivers

- One spelling of a principal in every table that joins on it; the SQL comparisons are
  case-sensitive `=`.
- Existing rows must keep matching: role keys were stored verbatim, mixed case included.
- A failure to parse must not turn into "some user".
- The type must be usable by the kernel, the orchestrator and plugins without a new
  dependency edge.

## Considered Options

- **A — A discriminated union `{ kind: 'user', userId } | { kind: 'role', roleKey }` with a
  per-kind canonicalisation rule, in the channel SDK.**
- **B — A single `{ kind, ref: string }` shape with one canonicalisation rule.**
- **C — Keep formatted strings** (`user:<id>`) as the only form.
- **D — A principal that carries its entitlements** (roles, attributes) with it.

## Decision Outcome

Chosen option: **A** (`middleware/packages/harness-channel-sdk/src/principal.ts`).

- **Two kinds, two differently named fields.** A `user` carries `userId`, a `role` carries
  `roleKey`. A shared `ref` field would read the same at every call site while obeying two
  rules.
- **Canonicalisation differs by kind.** `user` references are trimmed and lower-cased
  (e-mail and UPN ids are case-insensitive, GUIDs already lower case). `role` keys are
  trimmed only, because `createRole` writes the key verbatim and lower-casing would stop
  matching every mixed-case row in a live `conductor_roles` table.
  `canonicalizePrincipalRef` is the one implementation; `conductor/principalId.ts`
  delegates to it.
- **Wire form.** `user:<id>` / `role:<key>`; `parsePrincipal` splits on the first separator
  only, because references legitimately contain colons (`user:teams:<aad-oid>`).
- **Absence is a type.** `makePrincipal` returns `undefined` for an empty reference and
  `parsePrincipal` for an unknown prefix; neither falls back to a `user`.
- **A user and a role are never equal** (`principalsEqual`), even when their references
  match: a role is a late-bound indirection resolved through the role holder source.
- **Who, never may.** Nothing in the module evaluates a permission. The boundary from spec
  575 §6 holds: identity resolution produces principals; scopes, grants and the audience
  floor consume them and produce decisions.
- **Consumers canonicalise on write and on read.** The audience grant store, the credential
  store and the credential ask store use the same rule on both paths, so a grant written
  for `Alice@Example.com` matches a lookup for `alice@example.com`.

### Consequences

- 🟢 **Good:** Grants, credentials, asks and approvals join on one spelling.
- 🟢 **Good:** The asymmetric rule is visible in the type instead of hidden in a string.
- 🔴 **Bad:** `Principal` does not unify the identifiers a person has elsewhere. The session
  `sub`/e-mail (MCP token key, `auth/sessionIdentity.ts`), `omadia_user_id` (knowledge-graph
  cluster id, the caller of a credential ask), `users.id` (audit actor) and the two
  channel forms of ADR-0032 remain separate namespaces, and each call site must know which
  one it holds.
- 🔴 **Bad:** `conductor-core` keeps its own `Principal` interface
  (`packages/conductor-core/src/types.ts`), so two types share the name.
- 🔴 **Bad:** Lower-casing user ids is lossless only as long as every id source is
  case-insensitive; a future case-sensitive id space would collide.
- ⚪ **Neutral:** There are two kinds because the Conductor schema constrains to two; an
  agent or a service account is not a principal kind today.

## Pros and Cons of the Options

### A — Discriminated union, per-kind rule

- 🟢 The difference between the kinds survives review.
- 🔴 Every consumer handles two variants.

### B — One `ref` field

- 🟢 Less code.
- 🔴 Collapsing the rules is a silent routing bug in whichever direction: lower-cased roles
  stop reaching their holders, case-preserved users miss their bindings.

### C — Strings only

- 🟢 No type.
- 🔴 A naive `split(':')` drops everything after the second colon.

### D — Entitlements on the principal

- 🟢 One object answers "who" and "may they".
- 🔴 Identity and permission would be built in one place twice; spec 575 §6 forbids it.

## More Information

- Code: `middleware/packages/harness-channel-sdk/src/principal.ts`,
  `middleware/src/conductor/principalId.ts`, `middleware/src/audience/postgresGrantStore.ts`,
  `middleware/src/credentials/postgresCredentialStore.ts`.
- Tests: `middleware/test/principal.test.ts`, `test/conductorPrincipalRef.test.ts`,
  `test/resolveTurnOwnerPrincipal.test.ts`.
- Spec: `specs/575-scope-and-identity-foundation/spec.md` §6.
- Related: ADR-0032 (routing principal vs conversation form), ADR-0016,
  [ADR-0102](0102-credential-broker-stamps-secrets-and-owner-only-asks.md),
  [ADR-0100](0100-admin-audit-trail-one-actor-rule.md).
- Border: channels / identity, Conductor.
