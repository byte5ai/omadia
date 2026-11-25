# 0060 — The capability-plugin package contract lives in the boilerplate; two reference plugins keep it honest

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main)
- **Supersedes:** —

## Context and Problem Statement

A plugin arrives as a ZIP ([ADR-0001](0001-plugin-distribution-via-signed-zip.md)) and is
built outside the kernel's source tree: by a plugin author in their own repository, or by the
Plugin Builder in a staging directory. Both need one written answer to "what must a package
look like so that ingest accepts it and the runtime can activate it", and both need working
code to copy from. Documentation alone goes stale against the runtime.

This record is retroactive. Where does the package contract live, and what keeps it true?

## Decision Drivers

- A package must compile and load without the kernel's source tree.
- Model-written code must cite real patterns, not invented ones.
- The contract must be checked by machines where it can be.

## Considered Options

- **A — Contract in the boilerplate (`CLAUDE.md`, ten points) plus two runnable reference
  plugins in the repository, flagged reference-only**
- **B — Contract only as prose in `docs/`**
- **C — Publish `@omadia/plugin-api` to npm and let packages depend on it**

## Decision Outcome

Chosen option: **A**.

- **The contract is `middleware/assets/boilerplate/integration/CLAUDE.md`** ("Die 10
  Checkliste-Punkte"); `tool/CLAUDE.md` names only the differences. The points bind every
  capability-plugin package:
  1. `PluginContext` is duplicated locally in `./types.ts`; no import from the kernel tree.
  2. The exact accessor shapes (`ctx.secrets.*` async, `ctx.config.*` sync, `ctx.log`).
  3. `package.json`: `name` = `manifest.identity.id`, `version` = `identity.version`,
     `"type": "module"`, `main: dist/index.js`, dependencies as `peerDependencies`, `private`.
  4. `tsconfig.json`: `NodeNext`, `strict`, no include outside the package.
  5. The ZIP holds runtime artefacts only (manifest, `package.json`, `dist/`, `assets/`).
  6. Tools go through `ctx.tools.register`; `activate(ctx)` returns `{ close }`.
  7. No system prompt, no `AGENT.md`, no persona keys
     ([ADR-0014](0014-plugins-are-only-the-delivery-form.md)).
  8. The Zod subset the tool bridge turns into an input schema.
  9. Lifecycle budgets: `activate` 10 s, optional `verifyConnection` 5 s, `close` 5 s.
  10. The shipped `scripts/build-zip.mjs` produces `out/<id>-<version>.zip`.
- **Standalone compile is enforced for generated code.** `forbiddenInternalPackages.ts` lists
  `@omadia/plugin-api` and `@omadia/channel-sdk` as packages a slot must never import;
  `workspaceImportResolver.ts` refuses them before `tsc`, and `list_package_types` answers with
  the hint to read `./types.ts`. Integration packages offered through `serviceTypeRegistry`
  stay importable on purpose.
- **Two reference plugins are part of the repository.**
  `middleware/packages/agent-reference-maximum` (kind `integration`, credential-less, every
  plugin-API pattern, `INTEGRATION.md` as pattern index) and
  `middleware/packages/agent-seo-analyst` (kind `tool`, compact). The Builder reads them and
  both boilerplates through `read_reference` / `list_references`
  (`builderReferenceCatalog.ts`); installed `integration` plugins are added to that catalog
  per turn.
- **Reference-only plugins are not products.** `is_reference_only: true` in the manifest
  (`manifestLoader.ts`) keeps a package out of the operator catalog and out of activation
  (`capabilityPlugins.ts`, `toolPluginRuntime.ts`).
- **Bit rot is checked.** `npm run check:integration-md` validates the file:line references in
  `INTEGRATION.md`; `npm run manifest:i18n:check` the `{ en, de }` manifest texts.

### Consequences

- 🟢 **Good:** One document and two code bases answer every "how do I" of a plugin author and
  of the Builder model.
- 🟢 **Good:** A generated package compiles from its own files plus declared peers.
- 🔴 **Bad:** `types.ts` is a hand-kept copy of the host contract in every package; a breaking
  change to `PluginContext` must be carried into the boilerplates, both reference plugins and
  every external plugin ("Absicht nicht Bug", checklist point 1).
- 🔴 **Bad:** The contract text is not fully consistent: point 1 forbids importing the host
  contract, while the `verifyConnection` example under point 9 imports
  `classifyHttpAuthFailure` from `@omadia/plugin-api`, which the slot import gate refuses.
- 🔴 **Bad:** The contract is written in German, the code base and ADRs in English.
- ⚪ **Neutral:** Both reference packages keep the historical `agent-` prefix because installed
  instances reference the ids (`agent-reference-maximum/README.md`).

## Pros and Cons of the Options

### A — Boilerplate contract plus reference plugins

- 🟢 Runnable truth next to the rules; CI can check references.
- 🔴 Duplicated types; two extra packages to keep current.

### B — Prose only

- 🟢 Cheapest.
- 🔴 Nothing fails when the runtime moves on; models hallucinate the gaps.

### C — Published plugin-api dependency

- 🟢 No duplicated types.
- 🔴 `@omadia/plugin-api` is `private: true` and not published; a registry dependency at
  build time contradicts the self-contained ZIP of ADR-0001.

## More Information

- Related: [ADR-0001](0001-plugin-distribution-via-signed-zip.md),
  [ADR-0014](0014-plugins-are-only-the-delivery-form.md);
  [ADR-0064](0064-plugin-builder-spec-and-slots-into-boilerplate-templates.md). Border: plugin-runtime (the
  plugin-api snapshot and `compat.core` rules are recorded there).
- Paths: `middleware/assets/boilerplate/{integration,tool}/`,
  `middleware/packages/agent-reference-maximum/`, `middleware/packages/agent-seo-analyst/`,
  `middleware/src/plugins/builder/{forbiddenInternalPackages,workspaceImportResolver,builderReferenceCatalog}.ts`,
  `middleware/scripts/check-integration-md.mjs`.
- Tests: `middleware/test/builder/{workspaceImportResolver,builderReferenceCatalog,boilerplatePiiFields}.test.ts`,
  `middleware/test/builder/tools/{listPackageTypes,readReference}.test.ts`.
