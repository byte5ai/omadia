# 0058 — Builder drafts belong to one operator; a draft is installed through the same ingest as an uploaded ZIP

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main)
- **Supersedes:** —

## Context and Problem Statement

A Plugin Builder draft is work in progress: a spec, slots, two transcripts and test settings.
It is saved on nearly every keystroke and tool call. At some point it becomes an installed
plugin, and later the operator wants to change that plugin again.

This record is retroactive. Where do drafts live, who may see them, how does a draft become a
plugin, and what is the relation between an installed plugin and its draft afterwards?

## Decision Drivers

- Auto-save must be cheap; concurrent reads must not block it (the store's own rationale for
  WAL mode).
- A draft may contain half-finished code and test notes of one person.
- A generated plugin must not be easier to install than an uploaded one.
- Editing a published plugin must not take the running plugin away.

## Considered Options

- **A — SQLite file on the data volume, every query scoped by the owner's email; install =
  build + `PackageUploadService.ingest`; edit = clone**
- **B — Drafts in the shared Postgres, visible to all operators**
- **C — A dedicated install path for generated plugins** (trusted, skipping ingest checks)
- **D — Edit in place with a lock on the installed plugin**

## Decision Outcome

Chosen option: **A**.

- **Storage.** `DraftStore` (`draftStore.ts`): better-sqlite3, WAL, at
  `data/builder/drafts.db`, schema version 4 with in-code migrations. Spec, slots and
  transcripts are JSON text; validation happens above the store.
- **Ownership.** Every read and write filters by `user_email`. Another operator gets `404
  builder.draft_not_found`, also on the turn-resume and event routes. Deletion is soft
  (`deleted_at`).
- **Quota.** 50 active drafts per operator, warning from 40 (`draftQuota.ts`); soft-deleted
  drafts do not count, published ones do. It guards the shared volume, not against abuse.
- **Install is an upload.** `installDraft` (`installCommit.ts`) runs the build under its own
  queue key and hands the ZIP to `PackageUploadService.ingest()`: the same manifest validation,
  peer resolution, conflict rules and store as an operator upload. The route maps the result:
  404 `draft_not_found`; 409 `conflict` (id collides with a built-in, duplicate or older
  version, `compat.core` excludes the host); 413 `too_large`; 422 `spec_invalid`,
  `codegen_failed`, `build_failed`, `manifest_invalid`; 500 `pipeline_failed`, `ingest_failed`.
- **After install** the draft is `published` and pins `published_agent_id`. Statuses:
  `draft`, `published`, `archived`.
- **Edit is a clone, not a lock.** `POST /drafts/from-installed/:agentId`
  (`cloneFromInstalled.ts`) copies spec and slots of the source draft into a new draft of the
  same operator; the installed plugin keeps running. Re-publishing goes through install again
  and is refused on a duplicate version until the operator bumps `version`.
- **Mirror.** A draft save is mirrored into profile storage (`draftStorageBridge.ts`,
  `draft_id == profile_id`) for snapshots and diff; a mirror failure never fails the save.

### Consequences

- 🟢 **Good:** One install pipeline and one error contract for upload, Hub and Builder (#1519).
- 🟢 **Good:** A running plugin is never blocked by an edit in progress.
- 🟢 **Good:** Drafts live on the same volume as the vault and the uploaded packages and need
  no table in the shared database.
- 🔴 **Bad:** Drafts are single-owner. Another operator cannot continue a colleague's draft,
  and `from-installed` answers 404 `source_not_found` when someone else published the plugin or
  the source draft is gone; a plugin without a source draft cannot be opened in the Builder
  (reconstructing a spec from an installed package is out of scope in `cloneFromInstalled.ts`).
- 🔴 **Bad:** The owner key is the session email, not a user id; a changed email orphans drafts.
- 🔴 **Bad:** A local SQLite file binds the Builder to one middleware instance per volume.
- ⚪ **Neutral:** Two clones of the same plugin are independent; the later publish wins by
  version, there is no merge.

## Pros and Cons of the Options

### A — Owner-scoped SQLite, ingest install, clone to edit

- 🟢 Simple, no second trust path, no outage while editing.
- 🔴 No collaboration, single instance.

### B — Shared Postgres drafts

- 🟢 Collaboration and multi-instance.
- 🔴 Exposes unfinished work and test settings to every operator; a network round trip per
  auto-save.

### C — Dedicated install path

- 🟢 Faster.
- 🔴 A second way into the plugin store that the ingest checks do not see.

### D — Edit in place with a lock

- 🟢 One draft per plugin.
- 🔴 The plugin is unavailable or frozen while someone edits.

## More Information

- Related: [ADR-0001](0001-plugin-distribution-via-signed-zip.md);
  [ADR-0057](0057-builder-builds-as-host-child-process-with-shared-build-template.md),
  [ADR-0065](0065-plugin-self-extension-is-operator-gated-and-non-escalating.md) (reuses `installDraft`).
  Border: plugin-runtime (the ingest contract itself, `ingestErrorContract.ts`).
- Paths: `middleware/src/plugins/builder/{draftStore,draftQuota,installCommit,cloneFromInstalled,draftStorageBridge,types}.ts`,
  `middleware/src/routes/{builder,builderInstall,builderEdit}.ts`.
- Tests: `middleware/test/builder/{draftStore,draftQuota,installCommit,cloneFromInstalled,builderInstallRoutes,builderEditRoutes}.test.ts`.
