# 0091 — Fields are cleared only by a scoped operator entry; omadia suggests, an admin or a narrow auto-approval decides

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main);
  issue #1556; PRs #1629, #1630 (suggestions), #1651 (auto-approval); spec 2042 §5.10.
- **Supersedes:** —

## Context and Problem Statement

The shape classifier masks every text field it cannot prove safe
([ADR-0094](0094-privacy-shield-data-plane-boundary.md)). That hides harmless labels such as a department
or a job title, and agents then cannot answer "how many people per department". Some
fields must be clearable, but a field name alone says little: `name` on `res.country` is a
country, `name` on `res.partner` is a person.

Who may declare a field non-personal, at what scope, and how much of that may the system
decide by itself? This record is retroactive.

## Decision Drivers

- Clearing a field is a weakening; it must be explicit, scoped, recorded and reversible.
- Admins should not have to discover field names by hand.
- No field value may reach a model or a table for the purpose of classifying it.
- Defaults must work for an install whose admin never opens the page.

## Considered Options

- **A — One operator setting with scoped entries; schema-only suggestions; admin confirm;
  a narrow, revocable auto-approval that is on by default.**
- **B — A hand-written list only, by field name.**
- **C — Fully automatic clearing from a model's verdict.**
- **D — A built-in allowlist of safe fields per integration.**

## Decision Outcome

Chosen option: **A**.

- **The setting.** `non_personal_fields` of the privacy guard, empty by default. Entries
  are scoped per source and model: `odoo_execute:hr.employee/department_id`,
  `dataset:<uuid>/Abteilung`, `some_tool:-/category`. Legacy entries (`tool:field`,
  `*:field`, `field`) stay valid. A listed field clears as type `label` only when every
  value is text or an Odoo pair.
- **Scope is fixed at intern time** (`scopeOf` in `v4/datasetStore.ts`). A non-Odoo tool's
  input `model` is not trusted; a contradiction gives scope `!`, which no entry matches. A
  derived dataset clears a field only if the rule covers every source of its rows.
- **Masking wins.** The C0 identity booster overrides an entry. A tool's declared
  `piiFields` (plugin-api 1.83.0) mask a column whatever the classifier or an entry says;
  a declaration only adds masking.
- **Suggestions are schema-only.** The guard records masked fields per tool + scope +
  field and keeps a bounded in-memory sample (50 values, 24 h, 200 fields; never persisted
  or logged). The kernel (`src/privacy/fieldClassification/`) classifies on plugin
  activation, at boot, every 6 h and on demand, never per chat turn. A person-model target
  is `personal` and is never sent to a model. An unknown target goes to the small model
  with schema only; verdicts are cached 30 days in `privacy_model_verdicts`. A field is
  `suggested` only on a clean C1 vet, and never for scope `-`.
- **Admin confirm.** `/admin/privacy-fields` appends exactly the scoped entry under a
  per-plugin lock and writes an audit row; the receipt lists it (`operatorClearedFields`). Bulk accept re-validates each candidate, at
  most 500 per call; only the latest batch can be undone.
- **Auto-approval** (`auto_approve_non_personal`, default on). Eligible: every relation
  target is in the built-in non-personal catalog, or the verdict is `non-personal` above
  max(`auto_approve_confidence`, 0.8) and C1 vetted at least 10 values clean. Never for a
  person-model target, a field of a person scope (unless every target is on the explicit
  allow-list), conflicting targets, a detector hit or near-miss, scope `-`, or a field
  that already carries any decision. At most 1000 per pass; actor
  `system:auto-classifier`; audit row `privacy.field_auto_approve`. Every pass re-vets and
  revokes a field that is no longer eligible (`privacy.field_auto_revoke`), also with the
  switch off. Switching it off removes nothing already approved.
- **Admin preview of real values** comes from the kernel-only service
  `privacyFieldSamples` (`KERNEL_ONLY_SERVICE_NAMES`), at most 10 values, `no-store`,
  audited as `privacy.field_preview`; no audit log, no real value.

### Consequences

- 🟢 **Good:** Useful labels reach the model on a fresh install; person fields do not.
- 🟢 **Good:** Every clearing has an actor, an audit row and a way back.
- 🔴 **Bad:** C0 detects no names, so a listed field that holds names sends them to the
  model; the setting's help text says so.
- 🔴 **Bad (accepted residual):** an auto-approved verdict-based field rests on a schema
  verdict plus C1's vet of a bounded sample; names C1 misses reach the model until a
  re-vet or an admin catches them.
- 🔴 **Bad:** `provide` is ungated, so a plugin activating first could register
  `privacyFieldSamples` and show fabricated samples (never read real ones).
- ⚪ **Neutral:** ADR-0019 names this classification as a label source for discretion.

## Pros and Cons of the Options

### A — Scoped entries, suggestions, confirm, narrow auto-approval

- 🟢 Explicit and scoped; usable without admin effort for the obvious cases.
- 🔴 A large state machine (statuses, fingerprints, compare-and-set races).

### B — Hand-written list by name

- 🟢 Trivial; 🔴 the same name in a person model is cleared too, and nobody finds the names.

### C — Fully automatic

- 🟢 Zero effort; 🔴 a model's verdict alone would unmask person data.

### D — Built-in allowlist per integration

- 🟢 Deterministic.
- 🔴 Covers only integrations omadia knows; it survives as the catalog inside A.

## More Information

- Code: `middleware/packages/harness-plugin-privacy-guard/src/nonPersonalFields.ts`,
  `fieldObservations.ts`, `fieldVetting.ts`, `v4/declaredPii.ts`, `v4/modelClassifier.ts`;
  `middleware/src/privacy/fieldClassification/` (`engine.ts`, `autoApprove.ts`,
  `autoApprovePass.ts`, `bulk.ts`, `configEditor.ts`, `modelCatalog.ts`, `routes.ts`);
  migrations `0065_privacy_field_classification.sql`, `0066_privacy_field_auto_approve.sql`;
  `docs/security-architecture.md` §6f.
- Tests: `middleware/test/privacyNonPersonalFields1556.test.ts`,
  `privacyFieldClassificationEngine.test.ts`, `privacyFieldAutoApprove.test.ts`,
  `privacyFieldBulk.test.ts`, `privacyFieldClassificationRoutes.test.ts`,
  `privacyDeclaredPiiFields.test.ts`, `privacyFieldObservations.test.ts`.
