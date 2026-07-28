# Quality Guard (`@omadia/plugin-quality-guard`)

Response-quality core plugin. Publishes the `responseGuard@1` capability:
sycophancy levels (`off`/`low`/`medium`/`high`) plus a boundary-preset
library. The orchestrator splices the returned `prependRules` block into the
system prompt **ahead of** the body prose as its own cache element; profiles
without quality frontmatter inherit the global defaults configured here.

The plugin manipulates strings only — no network, graph, memory, or
filesystem access (all permission allow-lists are explicit-empty).

## Capability

| Surface | What it does |
|---|---|
| `responseGuard@1` | `getRules(profileQuality?)` → guardrail block for the system prompt. Per-profile overrides come from AGENT.md frontmatter; the `agent_overrides` map below is the pre-frontmatter fallback. |

## Config keys (`setup.fields`)

| Key | Type | Default | Notes |
|---|---|---|---|
| `default_sycophancy` | enum | `medium` | Global default for profiles without `quality.sycophancy`. `high` = devil's advocate. |
| `default_boundary_presets` | string | `""` | Comma-separated preset IDs (e.g. `no-financial-advice`, `no-medical-advice`, `privacy-first`, …). Unknown IDs are ignored. |
| `default_boundary_custom` | string | `""` | Free-text boundaries, one per line, spliced verbatim as bullet points. |
| `agent_overrides` | string | `""` | Optional JSON map `agentId → SycophancyLevel`; frontmatter wins once present. |

## Layout

Standard tool-plugin shape: `src/` → compiled `dist/` (`lifecycle.entry:
dist/plugin.js`). `boundaryPresets.ts` holds the preset library,
`sycophancyGuard.ts` the level → rules mapping, `configSchema.ts` the
setup-field parsing.

## PluginContext surface — v1.0 readiness audit (#431)

| Surface | Decision | Rationale |
|---|---|---|
| `ctx.jobs` | skip | Pure synchronous string assembly — nothing to schedule. |
| `ctx.status` | skip | No external connection or degraded mode to report. |
| `ctx.llm` | skip | Deterministic rule splicing by design; an LLM step would make guardrails nondeterministic. |
| `ctx.mcp` | skip | No external tooling involved. |

Versioning: stays independently versioned (currently `0.1.0`); does not bump
in lockstep with core.

## Tests

Central suite: `middleware/test/qualityGuardPlugin.test.ts`.
