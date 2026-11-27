# 0217 — Character sliders are target levels measured against a per-model-family baseline that the editor shows

## Status

Accepted

- **Date:** 2026-11-26
- **Deciders:** Owner (byte5) — decision after recommendation, reversible (#1893)
- **Supersedes:** —

## Context and Problem Statement

An agent's character is set with twelve 0–100 sliders (persona axes). The compiler
(`middleware/src/plugins/personaDelta.ts`, a kemia port) subtracts a baseline for the
agent's model family from each value and writes a line only when the difference
exceeds 15. The editor told operators that 50 is neutral, drew an unset axis at 50 and
never showed the baseline, so a slider "on neutral" could add a strong instruction
(sarcasm 50 against Sonnet's 15). The family itself was guessed: anything that was not
`haiku` or `opus` (Fable, class ids, "Auto", every non-Anthropic model) got the Sonnet
baseline.

What does a slider value mean, and against what is it measured?

## Decision Drivers

- Spec 2042 asks for a consistent personality: the same agent should read as the same
  character whichever model it runs on.
- What the operator sees must be what the prompt says: a slider at the displayed
  neutral point must add nothing, and an unset axis must look like one that adds
  nothing.
- The baseline must follow the model the agent really runs on, resolved the way the
  build resolves it.
- Reversible: the slider semantics and the baselines are data and one compiler; no
  stored value has to be migrated.

## Considered Options

- **A — Target levels against a per-family baseline, shown in the editor.** Keep the
  compiler; send the baseline of the agent's effective model family to the editor,
  draw it as the "model default" tick and the radar reference, put unset axes on it,
  and change the texts from "50 = neutral" to "neutral = model default".
- **B — 50 means "no change".** Treat each slider as a delta around 50 and drop the
  baselines from the compiler.
- **C — Keep everything, fix only the texts.**

## Decision Outcome

Chosen option: **A**, because only A keeps one character across models (a slider value
is the level the operator wants, and the compiler writes whatever each model needs to
reach it) and still makes the editor honest.

- **Semantics.** A slider value is an absolute target level. The compiler writes only
  the distance to the natural level of the model family the agent runs on
  (`NEUTRAL_THRESHOLD` / `STRONG_THRESHOLD` unchanged). An unset axis writes nothing.
- **Baseline in the editor.** `GET/PUT /api/v1/operator/agents/:slug/identity` return
  `persona_baseline: { family, axes }` for the agent's primary family. The editor draws
  `axes` as `DimensionSlider`'s "Model default" tick and as the radar's reference
  polygon, draws an unset axis on it, and says so in the hint (en + de). A value moved
  back onto the tick stores the baseline and, like an unset axis, writes nothing.
- **One family mapper.** `inferPersonaFamily` (`harness-orchestrator/src/personaFamily.ts`)
  maps a concrete model id to `haiku`, `sonnet`, `opus`, `fable` or a vendor family of
  `basePersonas.ts` (`openai-gpt`, `google-gemini`, …), else `unknown`. The middleware's
  `inferFamilyFromModel` and the turn loop's `Orchestrator.familyOf` are this function,
  so the stored per-family prompts and the fallback switch use the same keys.
- **Effective model.** An explicit policy primary names the family; otherwise the
  registry resolves the model exactly as the build does
  (`OrchestratorRegistry.runModelFor` → `resolveAgentRunModel`: policy, then
  `model_routing.main`, then the platform default, on the active provider). A class
  id, "Auto" or an unresolvable model maps to `unknown`, never to Sonnet.
- **Fable baseline.** `FAMILY_DEFAULTS.fable` is estimated and starts as Opus's values
  (the closest profiled tier); its own bucket lets a later measurement change only
  Fable.

### Consequences

- 🟢 **Good:** The same slider values describe the same character on every model, and
  the editor shows the reference they are measured against.
- 🟢 **Good:** Non-Anthropic models use the kemia vendor profiles that existed but were
  never reached.
- 🔴 **Bad:** Stored prompts of agents on Fable, non-Anthropic or unresolved models
  change on the next boot recompose (their family moves off `sonnet`); their character
  section may gain or lose lines.
- 🔴 **Bad:** The baseline is resolved at compose time. A change of the active provider
  or the platform default reaches an `auto` agent's persona at the next boot recompose,
  identity save or model-policy save, not immediately.
- ⚪ **Neutral:** The baselines remain estimates (`confidence: estimated`); measuring
  them is separate work.

## Pros and Cons of the Options

### A — Target levels against a shown baseline

- 🟢 Consistent character across models; honest editor.
- 🔴 The neutral point differs per axis and per model, so the UI has to show it.

### B — 50 means "no change"

- 🟢 One fixed neutral point; simple to explain.
- 🔴 The same values give a different character on each model, against spec 2042's
  consistent personality.

### C — Texts only

- 🟢 No code.
- 🔴 The unset-vs-50 trap and the Sonnet guess stay.

## More Information

- Issue #1893; related #1878, #1890 (identity assembly and Prompt preview), #1033
  (per-family prompts for the fallback).
- Code: `middleware/src/plugins/personaDelta.ts` (`FAMILY_DEFAULTS`, `personaBaseline`),
  `middleware/src/plugins/basePersonas.ts`, `middleware/src/services/agentIdentityPrompt.ts`
  (`agentPersonaFamilies`), `middleware/packages/harness-orchestrator/src/personaFamily.ts`,
  `registry/applyDiff.ts` (`resolveAgentRunModel`), `web-ui/app/operator/agents/[slug]/_components/AgentPersonaEditor.tsx`,
  `web-ui/app/_components/persona/{DimensionSlider,PersonaRadar}.tsx`.
- Tests: `middleware/test/agentIdentityPrompt.test.ts`,
  `middleware/test/operatorAgentsIdentityRoutes.test.ts`,
  `web-ui/app/operator/agents/[slug]/__tests__/AgentIdentityPersona.test.tsx`.
- Related: [ADR-0012](0012-agents-are-virtual-employees.md) (personality is part of the
  agent), [ADR-0163](0163-agent-runtimes-built-from-config-snapshot-and-reloaded-by-diff.md).
