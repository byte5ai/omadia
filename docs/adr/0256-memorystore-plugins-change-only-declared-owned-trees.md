# 0256 — Through `memoryStore@1` a plugin changes only the top-level trees it declares and owns

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** Owner decision by recommendation (wave 5, cluster W30; reversible), from
  #2232.
- **Supersedes in part:** [ADR-0044](0044-plugins-read-the-graph-through-bounded-services.md)
  (the `memoryStore@1` bullet: "It may use other top-level trees", `core` writable).

## Context and Problem Statement

Under ADR-0044 a plugin that declares `memoryStore@^1` gets a bounded store:

- no private trees;
- no loose root files;
- `_*` and `core/audit` read-only.

Every other top-level tree under `/memories` stays readable and writable by every such
plugin. An upload could read or rewrite channel-telegram's `/memories/pairings/*` and take
over a pairing. `core` was writable too. ADR-0033 protects only `core/audit` there, for
agents. Nothing ties a tree to the plugin that uses it.

Which trees may a plugin read and change, and who decides that a tree is a plugin's own?

## Decision Drivers

- A tree one plugin writes must not be readable or writable by another.
- channel-telegram (`pairings`) keeps working before and after its next release.
- The operator sees what a plugin asks for before install.
- `core` is curated, shared knowledge (ADR-0033); no shipped plugin writes it.

## Considered Options

- **A — Declared trees with first-user ownership.** The manifest declares
  `permissions.memory.trees`. The first plugin that uses a declared tree owns it, and the
  kernel records the owner.
- **B — Declared trees only.** Whoever declares a tree may use it.
- **C — One tree per plugin, derived from its id** (`/memories/plugins/<id>/…`).

## Decision Outcome

Chosen option: **A**. B lets a second plugin buy someone else's tree with one manifest
line. C breaks channel-telegram's paths and every stored pairing.

- **The field.** `permissions.memory.trees: ["pairings"]`, parsed into
  `permissions_summary.memory_trees` and shown on the store page ("Memory · Own trees").
  A name must be a lower-case slug. Private trees, `core` and `_*` names are dropped at
  load time (`isDeclarableMemoryTree`, `memoryTrees.ts`).
- **Reads.** A plugin reads `core`, the `_*` trees and its own trees. Another plugin's
  tree and any undeclared tree read as refused (`MemoryPathError`, naming the tree at
  most). A root listing shows only what the plugin may read. Reading another plugin's
  tree has no opt-in yet; a need comes with its own field and ADR.
- **Writes.** A plugin changes only its own trees. **`core` is read-only for plugins**
  (agents keep ADR-0033's rules), and so are the `_*` trees.
- **Ownership.** The first plugin to use (read or change) a declared tree claims it. The
  kernel writes `/memories/_plugin-trees/<tree>.json` (`{ pluginId, claimedAt }`) through
  the raw store. That tree is private: no plugin reads or changes it. Claims of one store
  are serialised in process; across processes the Postgres store's unique path decides.
  An unreadable record owns the tree for nobody.
- **Legacy row.** `LEGACY_MEMORY_TREE_OWNERS_2026_11_26` gives `pairings` to
  `@omadia/channel-telegram`. Without declaring it, telegram keeps the tree, and no other
  plugin can claim it. The row retires once telegram's released manifest declares
  `trees: ["pairings"]`.

### Consequences

- 🟢 **Good:** A second plugin writing `/memories/pairings/x` is refused; so is any read
  of another plugin's tree.
- 🟢 **Good:** The install surface shows the trees a plugin asks for.
- 🔴 **Bad (behaviour change):** A plugin that used an undeclared shared tree or wrote
  `core` through `memoryStore@1` is refused until it declares the tree. The audit of
  2026-11-25 (ADR-0044) found only channel-telegram doing so.
- 🔴 **Bad (residual):** The claim is first come, first served.
  - A plugin installed before the rightful one can claim a tree.
  - A tree that already held data with no record (written before this ADR) is adopted
    with its data by the first declarer. The audit found only `pairings`, which the
    legacy row covers.
  - There is no release UI yet: an operator releases a tree by deleting
    `/memories/_plugin-trees/<tree>.json` on the store. A plugin that already confirmed
    its ownership keeps it until restart (the check is cached per process).
  - The legacy row is keyed by id, which is not a credential (#789).
- ⚪ **Neutral:** Uninstalling a plugin keeps its record, so the tree stays its own after a
  reinstall.

## Pros and Cons of the Options

### A — Declared trees, first user owns

- 🟢 Closes the cross-plugin path; no path changes for telegram.
- 🔴 A record to keep; first-come residual.

### B — Declared trees only

- 🟢 No record.
- 🔴 Any upload can declare `pairings`.

### C — Per-id tree

- 🟢 Ownership by construction.
- 🔴 Breaks stored data and paths; a migration per plugin.

## More Information

- Code: `middleware/src/platform/memoryTrees.ts`, `boundedGraphServices.ts`
  (`boundMemoryStore`), `plugins/manifestLoader.ts`, `pluginContext.ts`; web-ui
  `app/store/[id]/page.tsx`.
- Tests: `test/boundedGraphServices.test.ts`, `test/pluginServiceGrantGate.test.ts`.
- Related: [ADR-0033](0033-memory-tool-protected-trees-and-seeded-rules.md),
  [ADR-0123](0123-scratch-memory-is-a-virtual-file-tree.md).
