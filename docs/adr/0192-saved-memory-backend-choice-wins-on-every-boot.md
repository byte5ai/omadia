# 0192 — The saved memory-backend choice wins over the environment on every boot

## Status

Accepted

- **Date:** 2026-11-26
- **Deciders:** Wave 5 cluster W03-04 (issue #1834), autonomous rollout mandate of 2026-11-23
- **Supersedes:** the sentence "The memory backend follows the environment on every boot" in
  [ADR-0047](0047-built-in-plugins-seeded-reconciled-sticky-uninstall.md) (boot-managed
  providers). The rest of ADR-0047 stays in force.
- **Confirms:** [ADR-0124](0124-storage-capabilities-ship-as-sibling-providers.md)
  ("persisted operator choice (`memory_backend`) → `MEMORY_BACKEND` → derived from `DATABASE_URL`")

## Context and Problem Statement

Two accepted records disagree. ADR-0047 says the memory backend "follows the environment on
every boot". ADR-0124 says the boot resolves it as persisted operator choice first, then
`MEMORY_BACKEND`, then the default derived from `DATABASE_URL`. The code implemented 0124 for
one boot only: `PUT /api/v1/admin/memory/backend` stored the choice as `memory_backend` on the
running provider's registry entry, and the next boot, which swaps to the chosen sibling,
removed exactly that entry. The newly installed sibling had no `memory_backend`, so the boot
after that fell back to the environment and silently swapped back, dropping everything the
in-memory store held (#1834). The admin page also showed the saved choice as the "active"
backend. Which rule holds, and where does the choice live so it survives the swap?

## Decision Drivers

- An operator choice made in the admin UI must not be undone by an unrelated restart.
- A swap back without notice loses data (in-memory contents) or hides data (Postgres rows).
- Only one `memoryStore@1` sibling is registered at a time (ADR-0124), so the choice cannot
  live on "the other" entry.
- Small change: no new store, no new config file.

## Considered Options

- **A — Carry the choice over:** the boot reads `memory_backend` before the swap and writes it
  onto the sibling it installs (or reconciles it onto the one already installed).
- **B — Separate store:** keep the choice in its own file or table next to `installed.json`.
- **C — Environment wins (ADR-0047 wording):** drop the UI switch and let `MEMORY_BACKEND` /
  `DATABASE_URL` decide on every boot.

## Decision Outcome

Chosen option: **A**, because it makes ADR-0124's precedence true across any number of boots
with a few lines in `bootstrapMemoryFromEnv`, needs no new storage, and keeps the existing
admin switch.

- `bootstrapMemoryFromEnv` reads the saved choice from whichever memory provider entry
  carries it before it removes the non-selected sibling, and writes the same
  `memory_backend` onto the sibling it installs or keeps.
- The choice is kept verbatim, also when the boot falls back to in-memory because
  `DATABASE_URL` is unset: once `DATABASE_URL` is back, the saved Postgres choice applies.
- With no saved choice, no `memory_backend` key is written; the environment decides as before.
- `GET /api/v1/admin/memory/backend` reports `current` = the backend that is running and
  `desired` = the saved choice the next boot applies. "Active backend" and the `/memory`
  badge read `current`; the admin page shows the saved choice separately while a restart is
  pending.

### Consequences

- 🟢 **Good:** a UI switch stays in effect until the operator changes it.
- 🟢 **Good:** the admin page and the `/memory` badge name the backend that is running.
- 🔴 **Bad:** an operator who later sets `MEMORY_BACKEND` in the environment does not get it
  while a UI choice is saved; they must switch in the UI. This is the precedence ADR-0124
  already states.
- ⚪ **Neutral:** installs that lost their choice to the old behaviour keep the environment
  default until the operator saves a choice again.

## Pros and Cons of the Options

### A — Carry the choice over

- 🟢 Minimal, local to the boot that already does the swap.
- 🔴 The choice still lives inside a provider's plugin config, which reads oddly.

### B — Separate store

- 🟢 The choice is independent of which provider is installed.
- 🔴 A new persisted file or table with its own backup and purge rules for one value.

### C — Environment wins

- 🟢 One source of truth.
- 🔴 Removes a working admin feature and contradicts ADR-0124.

## More Information

- Code: `middleware/src/plugins/bootstrap.ts` (`persistedMemoryBackend`,
  `bootstrapMemoryFromEnv`), `middleware/src/routes/memoryBackend.ts`,
  `web-ui/app/admin/memory-backend/page.tsx`.
- Tests: `middleware/test/bootstrap.test.ts` (#1834 cases),
  `middleware/test/memoryBackendRoute.test.ts`.
