# 0264 — An env seed may write a kernel fallback instead of removing the key

## Status

Accepted

- **Date:** 2026-11-27
- **Deciders:** W31 cluster lead (wave 6 autonomy grant)
- **Supersedes:** — (refines [ADR-0193](0193-env-vars-seed-boot-managed-plugin-config-only-when-set.md))

## Context and Problem Statement

ADR-0193 says an unset variable removes its boot-owned plugin key, so the plugin's own default
applies. Moving the remaining boot-seeded settings onto that rule (#2299) hit two keys whose
kernel default is not the plugin's default: `MEMORY_SEED_DIR` (the kernel resolves
`./seed/memory` against the middleware root; the memory plugins fall back to `memory-seed`
relative to the working directory — a different directory) and `GRAPH_EMBEDDING_MAX_CONCURRENT`
(kernel default 2, plugin default 4). Removing those keys would silently change behaviour on
every install that never set the variable. How do such keys follow ADR-0193?

## Decision Drivers

- No behaviour change for installs that never set the variable.
- One rule and one implementation (`applyEnvSeeds`) for every boot-seeded setting.
- Operator values keep winning.

## Considered Options

- **A — `EnvSeed.fallback`: the boot writes the kernel default for an unset variable, boot-owned like any seed.**
- **B — Change the plugins' defaults to the kernel's.**
- **C — Keep these keys on their old first-install-only rule.**

## Decision Outcome

Chosen option: **A**. `EnvSeed.fallback` (`src/plugins/envSeededConfig.ts`): when the variable is
unset and the key is boot-owned, `applyEnvSeeds` writes the fallback and records it in the
`_env_seeded` marker instead of deleting the key. Used for `seed_dir` (the resolved
`MEMORY_SEED_DIR` default) and `max_concurrent` (`2`). Also: a pre-marker value equal to the set
variable counts as boot-owned, because older boots reconciled `ollama_base_url` and friends from
the environment on every start. Memory (`seed_dir`, `seed_mode`), embeddings (`ollama_base_url`,
`ollama_model`, `max_concurrent`) and orchestrator-extras (`fact_extractor_model`,
`topic_classifier_model`, `topic_upper_threshold`, `topic_lower_threshold`) now reconcile on
every boot through `reconcileEnvSeeds`.

### Consequences

- 🟢 **Good:** Every boot-seeded setting follows ADR-0193; a variable added later takes effect at
  the next restart, an operator value wins and a shadowed variable is logged.
- 🟢 **Good:** Installs that never set the variables keep their seed directory and limiter.
- 🔴 **Bad:** On an install without the marker, a model or threshold that differs from both the
  built-in default and the current variable counts as the operator's, so a changed variable is
  logged as shadowed instead of applied (ADR-0193's accepted trade-off, now for more keys).
- ⚪ **Neutral:** Values are stored as strings; the plugins already parse strings.

## Pros and Cons of the Options

### A — Kernel fallback

- 🟢 Keeps behaviour, one mechanism.
- 🔴 The kernel default lives in the plugin config for these keys.

### B — Align plugin defaults

- 🔴 The plugin cannot know the kernel's resolved path; changes plugin behaviour elsewhere.

### C — Old rule for these keys

- 🔴 Two rules for one kind of setting; the issue stays open.

## More Information

Issue #2299; ADR-0193.
