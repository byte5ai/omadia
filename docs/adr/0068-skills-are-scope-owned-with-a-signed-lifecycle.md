# 0068 — A skill has a home scope, a four-state lifecycle and a signed manifest; sharing is a grant

## Status

Proposed — the model and routes exist, but `transition` and `assignPersonalOwner` have no
caller in the kernel yet (see Consequences). It becomes Accepted when the lifecycle is wired.

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; issue #577, implemented in #767 (ownership and lifecycle
  model, migration 0040), #768 (scope-ordered resolution), #771 (sharing through grants,
  promotion, automation write guard) and #792 (promotion route, signing key; issue #778).
  Recorded retroactively.
- **Supersedes:** —

## Context and Problem Statement

The skill registry was one flat list: every skill visible to everyone, no owner, no review
step, no evidence that a row is what was reviewed. Skills are instructions for agents
([ADR-0016](0016-least-privilege-and-the-agent-envelope.md): working modes), so who may
publish one for a team or the organisation, and which of two equally named skills applies to a
person, are access questions.

This record is retroactive, and it records a model that is only partly wired on main (see
Consequences). What is the ownership and lifecycle model of a skill?

## Decision Drivers

- A personal experiment must not become team or organisation instructions by accident.
- Unreviewed content must never win over reviewed content.
- An automation must not rewrite the instructions agents work by.
- No second access-control system next to the grant store.
- Uncertainty is reported, never resolved by picking something.

## Considered Options

- **A — Owner scope + explicit lifecycle + HMAC-signed canonical manifest + scope-ordered
  resolution + sharing as grants**
- **B — Keep the flat registry and add a visibility flag**
- **C — A dedicated ACL table per skill**

## Decision Outcome

Chosen option: **A** (`middleware/src/services/skillLifecycle.ts` and siblings).

- **Home scope.** `skills.owner_scope` holds a `ScopeId` wire string of kind `personal`,
  `group` or `org` (`isSkillOwnerScope`); conversations, `system` and `unscoped` cannot own a
  skill. `NULL` means a legacy, unowned skill. A skill starts personal; team or organisation
  ownership is reached only by promoting an already published skill
  (`promoteSkillOwnerScope`, `POST /api/v1/admin/skills/:skillId/promote`).
- **Lifecycle.** `draft → reviewed → published → archived`, plus `reviewed → draft`. The edge
  list in `SKILL_LIFECYCLE_EDGES` is the only authority; `archived` is terminal; every row
  defaults to `draft` (migration `0040_skill_ownership_lifecycle.sql`).
- **Publish gate.** `frontmatter.requiredCapabilities` is the single source for what a skill
  needs; a malformed value throws `SkillManifestError`, it is never coerced. Publishing
  requires every listed capability in the resolved grant set.
- **Signed manifest.** `canonicalSkillManifest` fixes the signed bytes: `slug`, `name`,
  `ownerScope`, `status`, `contentHash`, `requiredCapabilities` in that order, `key=value`
  joined by `\n`, capabilities de-duplicated and sorted by code point, never case-folded.
  HMAC-SHA256 with a key generated once and kept in the vault under `core:skills`
  (`skillManifestSigningKey.ts`), separate from the session key. Changing the canonical form
  is a signing-format break; a byte-exact test locks it. Promotion re-signs, because the owner
  is a signed field.
- **Automations may not write skills.** `assertHumanActor` refuses an actor scope of kind
  `system` before any query runs (`SkillAutomationWriteBlocked`).
- **Resolution by name** (`skillResolver.ts`): personal beats shared beats team beats org;
  candidates that are not `published` are removed before ranking; two candidates in the same
  bucket yield `ambiguous` with the candidate set, never an arbitrary pick.
- **Sharing is a grant** (`skillSharing.ts`): capability `skill:read:<skillId>` in the
  existing `GrantStore`. An unresolved grant lookup is reported and, for callers that only
  need the set, degrades to "no shares visible", because here a failure can only hide a skill.

### Consequences

- 🟢 **Good:** One vocabulary (scope ids, capabilities, grants) for skills, audiences and
  published apps.
- 🟢 **Good:** The dangerous failure of a shadowing lookup (a result from the wrong level) is
  excluded by construction and tested.
- 🔴 **Bad:** The model is ahead of its wiring. On main only the promotion route is mounted
  (and only with a graph pool). `transition` and `assignPersonalOwner` have no caller in
  `middleware/src`, so no product path gives a skill an owner or moves it to `published`, and
  promotion answers `409 skill_promotion.not_eligible` for every skill created through the
  UI. `resolveSkillByName` and `verifySkillManifestSignature` have no runtime caller either:
  agents still receive skills through the flat registry and Agent Builder links, regardless
  of `lifecycle_status`.
- 🔴 **Bad:** "Admin-gated" promotion means "any authenticated operator session"; there is no
  role below operator.
- 🔴 **Bad:** Rotating the signing key invalidates every signature; there is no key id in the
  manifest.
- ⚪ **Neutral:** `skills.slug` stays globally unique, so shadowing works on `name`.
- ⚪ **Neutral:** The opposite failure default to published apps is deliberate
  ([ADR-0067](0067-published-apps-are-immutable-versions-behind-their-own-origin.md) denies on an unresolved
  lookup).

## Pros and Cons of the Options

### A — Scope, lifecycle, signature, grants

- 🟢 Reuses scope ids and the grant store; tamper evidence; explicit review.
- 🔴 Several phases must all be wired before operators benefit.

### B — Visibility flag

- 🟢 Small.
- 🔴 No review step, no shadowing rule, no evidence.

### C — Per-skill ACL table

- 🟢 Self-contained.
- 🔴 A parallel permission system that the audience floor and role sources do not know.

## More Information

- Related: [ADR-0016](0016-least-privilege-and-the-agent-envelope.md),
  [ADR-0023](0023-facilitator-working-modes-settings-and-channel-readiness.md) (working modes
  attach skills to agents); [ADR-0061](0061-content-verdicts-are-advisory-and-never-read-as-clean-by-default.md).
  Border: agents (skill registry and Agent Builder), auth-security (grants, scope ids).
- Paths: `middleware/src/services/{skillLifecycle,skillLifecycleStore,skillResolver,skillSharing,skillManifestSigningKey}.ts`,
  `middleware/src/routes/skillPromotion.ts`,
  `middleware/migrations/0040_skill_ownership_lifecycle.sql`.
- Tests: `middleware/test/{skillLifecycle,skillResolver,skillSharing,skillPromotionRoute}.test.ts`,
  `middleware/test/{skillLifecycleStore,skillOwnershipLifecycleStore}.pg.test.ts`.
