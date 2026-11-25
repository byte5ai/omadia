# 0064 — The Plugin Builder writes a spec and slots into boilerplate templates, never a free-form package

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); kind
  split `integration` / `tool` from #2143 (epic #2042, S2)
- **Supersedes:** —

## Context and Problem Statement

The Plugin Builder lets an operator describe a capability plugin in a chat and get an
installable ZIP ([ADR-0001](0001-plugin-distribution-via-signed-zip.md)). A model writes the
code. A package is only installable when manifest, `package.json`, entry point, tool
registration and build script agree with the host runtime, and none of that may depend on what
a model happened to emit in one turn.

This record is retroactive: it documents what `middleware/src/plugins/builder/` does on main.
Which part of a generated plugin does the model author, and which part is fixed?

## Decision Drivers

- A generated package must pass the same ingest as an uploaded one, every time.
- The operator edits the same artefact the model edits (inline editor and chat stay in sync).
- A new kind of generated plugin must not need a codegen patch.
- [ADR-0014](0014-plugins-are-only-the-delivery-form.md): the Plugin Builder creates
  capability plugins, never agents or personas.

## Considered Options

- **A — Structured spec plus named code slots, injected into an on-disk boilerplate template**
- **B — The model writes the whole package** (every file, manifest included)
- **C — Declarative plugins only** (a spec interpreted at runtime, no generated code)

## Decision Outcome

Chosen option: **A**.

- **The draft is data.** A draft holds an `AgentSpec` (`agentSpec.ts`, Zod, JSON-serialisable;
  the name is historical) and a `Record<string, string>` of slots. The model changes them only
  through the builder tools `patch_spec` (RFC-6902 subset, `specPatcher.ts`) and `fill_slot`;
  the operator's inline editor writes the same two fields. Both emit on one `SpecEventBus`.
- **Templates live on disk.** `middleware/assets/boilerplate/<id>/` with a `template.yaml`
  (`slots[]`, `placeholders`, `skip_files`; `boilerplateSource.ts`). Today: `integration`
  (`client.ts` + `toolkit.ts`) and `tool` (`toolkit.ts` only). `bootstrapTemplates()` discovers
  them and calls `registerAgentTemplate(id)`; the template `id` must equal its directory name.
- **Template and kind are separate.** `template` picks the code layout, `kind` is the manifest
  kind. When the spec leaves `kind` out, `effectivePluginKind` derives it: `integration` when
  the plugin reaches an external system with credentials, else `tool`. `PLUGIN_BUILDER_KINDS`
  admits nothing else; `RETIRED_SPEC_KEYS` (`skill`, `persona`, `quality`) are stripped.
- **Codegen is mechanical and fails loud** (`codegen.ts`): slot text replaces the body between
  `// #region builder:<key>` and `// #endregion` (markers stay); `{{TOKEN}}` placeholders
  resolve against the spec; manifest capabilities, `depends_on` and
  `permissions.network.outbound` are written through the YAML AST. A missing required slot, a
  slot without its marker and any `{{TOKEN}}` left in a text file are errors
  (`missing_required_slot`, `missing_marker`, `placeholder_residue`), never a best-effort file.
- **Some slots are codegen-owned.** `plugin-imports`, `external-reads-*` and `ui-routes-*` are
  synthesised from the spec (`spec.external_reads`, `spec.ui_routes`); the model adds such
  wiring through `patch_spec`, not by hand-writing the region.
- **Fixed code stays fixed.** `registerTools.ts`, `index.ts`, `types.ts`, `tsconfig.json` and
  `scripts/build-zip.mjs` carry no model-authored region.

### Consequences

- 🟢 **Good:** Every generated package has the same layout, entry point and build script; the
  ingest failure modes are those of the template, tested once.
- 🟢 **Good:** A new plugin layout is a directory drop plus a registration.
- 🟢 **Good:** Spec and slots diff, patch and replay cleanly (two tabs, auto-fix turns, clone).
- 🔴 **Bad:** What a template has no slot or spec field for cannot be generated; every new
  platform feature for generated plugins costs a spec field, a codegen branch and a template
  change (see the growth of `codegenUiRoute.ts` and the `external_reads` regions).
- 🔴 **Bad:** Historical names stay in the contract (`AgentSpec`, `registerAgentTemplate`,
  package ids `@omadia/agent-<slug>`, the legacy reverse-FQDN id form), because stored drafts
  and installed packages reference them.
- ⚪ **Neutral:** The boilerplate `CLAUDE.md` is appended to the builder system prompt
  (`builderAgent.ts`, `prompts/builder-system.md`), so template and instructions ship together.

## Pros and Cons of the Options

### A — Spec plus slots into a template

- 🟢 Deterministic package shape; only bounded regions are model-authored.
- 🔴 Expressiveness is bounded by the templates.

### B — Model writes the whole package

- 🟢 Unlimited expressiveness.
- 🔴 Manifest, package metadata and build script drift per turn; nothing to diff or lint as data.

### C — Declarative only

- 🟢 No build step, no generated code to trust.
- 🔴 No custom logic; an integration with a real API client does not fit.

## More Information

- Related: [ADR-0014](0014-plugins-are-only-the-delivery-form.md),
  [ADR-0001](0001-plugin-distribution-via-signed-zip.md); new drafts
  [ADR-0060](0060-capability-plugin-package-contract-and-reference-plugins.md),
  [ADR-0056](0056-builder-agent-bounded-by-deterministic-gates.md),
  [ADR-0057](0057-builder-builds-as-host-child-process-with-shared-build-template.md).
- Paths: `middleware/src/plugins/builder/{agentSpec,codegen,boilerplateSource,specPatcher,specEventBus}.ts`,
  `middleware/src/plugins/builder/tools/`, `middleware/assets/boilerplate/{integration,tool}/template.yaml`.
- Tests: `middleware/test/builder/{codegen,boilerplateSource,agentSpec,specPatcher,reservedNames}.test.ts`,
  `middleware/test/builder/tools/{patchSpec,fillSlot}.test.ts`.
