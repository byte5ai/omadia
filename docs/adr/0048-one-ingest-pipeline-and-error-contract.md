# 0048 — One ingest pipeline for every package door, and one error contract (409 / 413 / 422)

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); status contract from #1477, downgrade consent #1455, bundled-id refusal #789, activation result #1452/#1497, boundary check from spec 2042 §5.10
- **Supersedes:** —

## Context and Problem Statement

A plugin package ([ADR-0001](0001-plugin-distribution-via-signed-zip.md)) reaches an
instance through several doors: an operator's ZIP upload, an install from a registry, the
`depends_on` chain of another install, the Plugin Builder's install and a vendored plugin
inside a profile bundle. Each door once mapped the pipeline's refusals to HTTP on its own,
and they drifted: the registry route answered 422 where the upload answered 409 and
dropped `params` and `details`; the builder answered `package.incompatible_core` and every
`zip.*` code with 500. Checks added at one door were missing at the others. This record is
written retroactively; the decision is implemented on main.

Where is a package validated, and what does a refusal look like to a client?

## Decision Drivers

- A package is untrusted input; every door must apply the same checks.
- A client must be able to tell "this host says no" from "this package must change".
- Refusals must be localizable: a stable code plus parameters, not a sentence.
- A code nobody mapped yet must never become a server fault.

## Considered Options

- **A — One `PackageUploadService.ingest` behind every door; status and body from one
  module**
- **B — Per-door validation and mapping** (the previous state)
- **C — One pipeline, but each route keeps its own status mapping**

## Decision Outcome

Chosen option: **A**.

- **Every door hands a buffer to `PackageUploadService.ingest`**
  (`middleware/src/plugins/packageUploadService.ts`). The registry client adds no
  validation of its own beyond the SHA-256 of the download.
- **What ingest checks, before anything is stored:**
  - size caps: `PACKAGE_UPLOAD_MAX_BYTES` (15 MiB), `PACKAGE_UPLOAD_MAX_EXTRACTED_BYTES`
    (80 MiB), `PACKAGE_UPLOAD_MAX_ENTRIES` (2000);
  - safe extraction (`zipExtractor.ts`): no path escape, no symlinks, an extension
    allowlist (`zip.forbidden_extension`);
  - manifest and `package.json` shape, id and version agreement, a scannable entry file;
  - the agent/plugin boundary of [ADR-0014](0014-plugins-are-only-the-delivery-form.md)
    (`package.retired_kind`, `package.persona_declared`), checked at ingest only;
  - `compat.core` ([ADR-0049](0049-plugin-api-semver-snapshot-and-compat-core.md));
  - id conflicts with a built-in or bundled package. Overriding a bundled id needs the
    environment variable `PLUGIN_ALLOW_BUNDLED_ID_OVERRIDE=1` on the host, never a request
    parameter;
  - versions: the same version again is `package.duplicate_version`; an older one is
    `package.downgrade_blocked` unless the request carries `allowDowngrade`; an update
    that makes a plugin an archetype plugin or changes its archetype needs
    `confirmArchetype`;
  - the `onMigrate` hook of the new version, under a timeout; a throw aborts the upload
    and the old version stays active.
- **One status rule** (`ingestFailureStatus` in `ingestErrorContract.ts`):
  - **409**: the package is fine, this host says no (`INGEST_CONFLICT_CODES` and
    `package.incompatible_core`);
  - **413**: the archive or its extracted content is over a cap;
  - **422**: everything else, and the default for any unmapped code.
- **One body:** `{ code, message, params?, details? }`. `message` is display text in one
  fixed language; clients localize from `code` and `params`.
- **A successful ingest does not claim the plugin runs.** `activated: true` is present
  only when this ingest started the plugin; `activation_error` and the shared `activation`
  result are present when it tried and failed
  ([ADR-0046](0046-activation-soft-fail-circuit-breaker-and-typed-result.md)).

### Consequences

- 🟢 **Good:** A check added to the pipeline holds at every door at once.
- 🟢 **Good:** The UI can word every refusal in the operator's language and offer the
  right next step (confirm a downgrade, update omadia, fix the package).
- 🔴 **Bad:** The fixed-language `message` is German in places (the size-cap text), so a
  client that shows it unlocalized mixes languages.
- 🔴 **Bad:** Ingest hashes the ZIP but verifies no publisher signature; the header of
  `packageUploadService.ts` lists AST import scan, sandboxed activation and a remote
  signature check as out of scope.
- 🔴 **Bad:** `onMigrate` writes to the vault and memory are not rolled back when the hook
  later throws; authors must keep migrations idempotent.
- ⚪ **Neutral:** Downgrade consent is a request flag because it harms only the operator's
  own plugin; the bundled-id override is host configuration because it replaces code the
  host ships.

## Pros and Cons of the Options

### A — One pipeline, one contract

- 🟢 No drift between doors; new codes change all routes together.
- 🔴 Every door inherits every check, including ones it did not need before.

### B — Per-door validation

- 🟢 Each route stays independent.
- 🔴 The drift that #1477 removed.

### C — Shared pipeline, per-route mapping

- 🟢 Routes can keep historical status codes.
- 🔴 The same code answered 409, 422 and 500 depending on the door.

## More Information

- Related: [ADR-0001](0001-plugin-distribution-via-signed-zip.md),
  [ADR-0014](0014-plugins-are-only-the-delivery-form.md),
  [ADR-0015](0015-agent-archetypes-and-archetype-plugins.md) (install confirmation).
- Paths: `middleware/src/plugins/packageUploadService.ts`, `ingestErrorContract.ts`,
  `zipExtractor.ts`, `pluginBoundary.ts`, `migrationRunner.ts`,
  `dependencyChainResolver.ts`; routes `middleware/src/routes/packages.ts`,
  `routes/registryInstall.ts`; `middleware/src/config.ts` (`PACKAGE_UPLOAD_*`).
- Tests: `middleware/test/installUploadErrorContract.test.ts`,
  `packageUploadService.test.ts`, `pluginBoundary.test.ts`,
  `dependencyChainResolver.test.ts`.
- Border: the builder door (`plugins/builder/installCommit.ts`) belongs to the Builder
  domain; it uses this contract.
