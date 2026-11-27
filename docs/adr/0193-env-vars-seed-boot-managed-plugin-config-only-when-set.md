# 0193 — Environment variables seed boot-managed plugin config only when set; a stored operator value wins

## Status

Accepted

- **Date:** 2026-11-26
- **Deciders:** Wave 5 cluster W03-04 (issue #1858), autonomous rollout mandate of 2026-11-23
- **Supersedes:** —
- **Related:** [ADR-0047](0047-built-in-plugins-seeded-reconciled-sticky-uninstall.md)
  (boot-managed providers), [ADR-0054](0054-setup-fields-typed-secrets-in-per-plugin-vault-validated-server-side.md)
  (setup fields), [ADR-0192](0192-saved-memory-backend-choice-wins-on-every-boot.md)

## Context and Problem Statement

The boot migrates legacy environment variables into the config of the boot-managed plugins
it installs. For `@omadia/knowledge-graph-neon` it wrote all four
`GRAPH_EMBEDDING_BACKFILL_*` keys on the first install, as their schema defaults when the
variables were unset, and never looked at them again. The plugin reads its config first and
the variable only when the key is missing, so a variable added later had no effect and nothing
said so (#1858), while `config.ts` still validated it on every boot. No record states how an
environment variable and a stored plugin setting relate. Which one decides, and when?

## Decision Drivers

- An operator who sets a documented variable must see it take effect, or be told why not.
- A value an operator saved in the plugin settings must not be overwritten by a container
  variable on the next restart.
- Existing installs carry values the old migration wrote without anyone choosing them.
- The rule should be reusable for every boot-seeded plugin setting, not one plugin.

## Considered Options

- **A — Seed only set variables, track boot ownership:** the boot writes a key only when its
  variable is set and records the value it wrote in a hidden marker. A value that still equals
  the recorded one follows the variable on every boot; an edited value belongs to the operator
  and wins, and a set variable it shadows is logged.
- **B — Environment always wins:** the plugin reads the variable before its config.
- **C — Drop the variables:** remove them and their validation; plugin settings are the only
  way.

## Decision Outcome

Chosen option: **A**, because it keeps the documented variables working on existing installs,
keeps operator settings authoritative, and makes the one surprising case (a variable that is
overridden) visible in the boot log.

- `applyEnvSeeds` (`middleware/src/plugins/envSeededConfig.ts`) implements the rule. The
  marker is the hidden config key `_env_seeded`, a JSON object of the values the boot wrote.
- Set variable + boot-owned key → the key gets the variable's validated value.
- Set variable + operator value that differs → the value stays and the boot logs
  `⚠ <plugin>: <VAR>='<v>' is ignored — the plugin setting <key>='<stored>' was set by an
  operator and wins`.
- Unset variable + boot-owned key → the key is removed and the plugin's default applies.
- Entries written before the marker existed count as boot-owned where they still hold the
  built-in default (the old migration wrote those unasked); any other value is the operator's.
- Applied on the first install and on every later boot of the boot-managed provider.
  First user: the four `GRAPH_EMBEDDING_BACKFILL_*` variables of the Neon knowledge graph.

### Consequences

- 🟢 **Good:** a variable added on an existing install takes effect at the next restart.
- 🟢 **Good:** an operator setting is never overwritten, and an overridden variable is named in
  the log.
- 🔴 **Bad:** an operator who saved exactly the built-in default on a pre-marker install is
  treated as not having chosen it; a variable set later replaces it. We accept that, because
  the old migration made such values indistinguishable.
- 🔴 **Bad:** a hidden key in plugin config. An editor that replaces the whole config drops it,
  which falls back to the legacy reading above.
- ⚪ **Neutral:** other boot-seeded settings (memory seed paths, embeddings URLs) still follow
  their own older rules; moving them onto `applyEnvSeeds` is follow-up work.

## Pros and Cons of the Options

### A — Seed only set variables, track boot ownership

- 🟢 Both sources stay meaningful, with a clear winner.
- 🔴 Needs the marker and the legacy rule.

### B — Environment always wins

- 🟢 Simple and predictable for container operators.
- 🔴 Silently overrides values saved in the Store, the problem in the other direction.

### C — Drop the variables

- 🟢 One source of truth.
- 🔴 Breaks deployments that set them, and removes a way to configure a fresh install.

## More Information

- Code: `middleware/src/plugins/envSeededConfig.ts`, `middleware/src/plugins/bootstrap.ts`
  (`neonBackfillSeeds`, `reconcileNeonBackfillSeeds`).
- Tests: `middleware/test/envSeededConfig.test.ts`.
- Docs: `middleware/.env.example`, `docs/middleware-agent-handoff.md` §10.
