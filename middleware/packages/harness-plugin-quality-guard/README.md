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
| `default_boundary_presets` | string | `""` | Comma-separated preset IDs from the shared library in `@omadia/plugin-api` — the same 12 IDs the agent "Boundaries" tab offers (`no-financial-data`, `no-pii`, `no-medical-data`, `no-legal-advice`, `own-domain-only`, `no-code-execution`, `no-external-links`, `no-discount-authority`, `no-commitments`, `no-personnel-decisions`, `no-speculation`, `no-competitor-discussion`). The v0.1 plugin-only IDs (`no-financial-advice`, `no-medical-advice`, `internal-only`, `no-pii-collection`, `no-external-quotes`, `privacy-first`, `factual-only`, `no-reasoning-disclosure`) are still accepted with their old wording. Unknown IDs are logged at activation and ignored. |
| `default_boundary_custom` | string | `""` | Free-text boundaries, one per line, spliced verbatim as bullet points. |
| `agent_overrides` | string | `""` | Optional JSON map `agent slug → SycophancyLevel` (the slug from `/operator/agents/<slug>`); the agent's own setting wins over it. |

## How it combines with per-agent boundaries

Per agent the sources **override** each other: the agent's own setting
(agent editor "Boundaries" tab, or AGENT.md `quality` frontmatter) →
`agent_overrides` → these defaults. The orchestrator sends the guard the
agent's slug and its own settings on every turn (#1569).

The agent's own level and boundaries are already compiled into its own
prompt. For each of the two the agent set itself, this plugin adds nothing,
so a turn never carries two anti-flattery blocks of different strength.
Only what the agent left open comes from `agent_overrides` or the defaults,
and that block is prepended ahead of the agent's prompt.

Both read the same preset library (since 0.2.0), so an ID means the same rule
on both surfaces.

**Upgrading from 0.1:** an agent-UI ID (e.g. `no-pii`) saved in
`default_boundary_presets` was silently dropped by 0.1 and now applies to every
agent — review the field first. `no-speculation` now uses the shared wording
("do not guess when uncertain").

## Layout

Standard tool-plugin shape: `src/` → compiled `dist/` (`lifecycle.entry:
dist/plugin.js`). `boundaryPresets.ts` resolves preset IDs against the shared
library (`BOUNDARY_PRESETS` in `@omadia/plugin-api`) plus the legacy v0.1 IDs,
`sycophancyGuard.ts` the level → rules mapping, `configSchema.ts` the
setup-field parsing.

## PluginContext surface — v1.0 readiness audit (#431)

| Surface | Decision | Rationale |
|---|---|---|
| `ctx.jobs` | skip | Pure synchronous string assembly — nothing to schedule. |
| `ctx.status` | skip | No external connection or degraded mode to report. |
| `ctx.llm` | skip | Deterministic rule splicing by design; an LLM step would make guardrails nondeterministic. |
| `ctx.mcp` | skip | No external tooling involved. |

Versioning: stays independently versioned (currently `0.2.0`); does not bump
in lockstep with core.

## Tests

Central suite: `middleware/test/qualityGuardPlugin.test.ts`.
