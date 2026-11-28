# 0360 — Keychain admin surface: the owner revokes a personal credential, operators see metadata

## Status

Accepted

- **Date:** 2026-11-28
- **Deciders:** W52 cluster lead (wave 9, issue #2320; decision after the recommendation,
  reversible)
- **Supersedes:** —

## Context and Problem Statement

ADR-0102 built the keychain and decided who answers an ask (the owner, no admin override).
It left the admin surface open: who may list credentials and grants, and who may revoke a
credential or a grant. #2320 adds that surface (`/api/v1/admin/credentials`,
`/admin/credentials`). Revocation only reduces access, listing only reads, yet both touch the
same "the owner decides" driver ADR-0102 states. Who may see and who may revoke?

## Decision Drivers

- ADR-0102: the person who owns a credential decides about it; nobody else, an admin included.
- ADR-0113: omadia has one admin role; there is no role below operator.
- The secret never leaves the keychain, in any path.
- A leaked or unwanted grant must be stoppable without waiting on another person.

## Considered Options

- **A — Owner revokes personal credentials and their grants, any operator revokes service
  credentials; every operator sees metadata of all credentials and grants.**
- **B — Any operator revokes anything** (revoking only reduces access).
- **C — Owner-only for everything, including listing personal credentials.**

## Decision Outcome

Chosen option: **A** (`middleware/src/routes/adminCredentials.ts`).

- **Revocation.** A `personal` credential and every grant against it are revoked by its owner
  only: the caller is `user:<omadia_user_id>` from the session, the same identity rule as the
  asks router; anyone else gets `403 credential.forbidden`. A `service` credential has no
  single owner; any operator session revokes it and its grants.
- **Reading.** Every operator session lists every credential's metadata (name, kind, owner,
  broker declaration, created/revoked) and the grants against it (principal, mode, purpose,
  expiry, use, revocation). `can_revoke` / `can_revoke_grants` tell the UI what the server
  will allow.
- **Never in a body:** the secret, the sealed material, the fingerprint. The route's
  dependency type has no `getSecretMaterial`.
- **Audit.** `credential.revoke` and `credential.grant_revoke` rows (ADR-0100), names and
  principals only.

### Consequences

- 🟢 **Good:** "Only the owner decides" holds for revocation too; an admin cannot undo an
  owner's grant behind their back.
- 🟢 **Good:** Operators can see who holds access to which secret, which is what an audit of
  the keychain needs.
- 🔴 **Bad:** A grant's purpose text is visible to all operators, not only to the owner.
- 🔴 **Bad:** An owner who has left blocks revocation of their personal credential and its
  grants, as ADR-0102 already accepts for asks. Break-glass stays a follow-up.
- ⚪ **Neutral:** Creating credentials and per-agent grants are not part of this surface
  (#2319 adds per-agent grants).

## Pros and Cons of the Options

### A — Owner revokes personal, operators revoke service, operators read all metadata

- 🟢 Consistent with ADR-0102 for every decision about a personal credential.
- 🔴 Purpose text is shared with all operators.

### B — Any operator revokes anything

- 🟢 Stops a leak without the owner.
- 🔴 Makes "personal" mean "personal unless an admin disagrees", the exact outcome ADR-0102
  rejected for approvals.

### C — Owner-only for everything

- 🟢 Nothing of a personal credential is visible to others.
- 🔴 Nobody can answer "who can reach which secret" for the instance; the single admin role
  of ADR-0113 has no keychain overview at all.

## More Information

- Code: `middleware/src/routes/adminCredentials.ts`, `web-ui/app/admin/credentials/`.
- Tests: `middleware/test/adminCredentialsRoute.test.ts`,
  `web-ui/app/admin/credentials/__tests__/page.test.tsx`.
- Docs: `docs/security-architecture.md` §10c item 8.
- Related: [ADR-0102](0102-credential-broker-stamps-secrets-and-owner-only-asks.md),
  [ADR-0100](0100-admin-audit-trail-one-actor-rule.md),
  [ADR-0113](0113-sign-in-providers-behind-one-contract-and-a-single-admin-role.md).
