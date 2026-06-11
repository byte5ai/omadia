# Plan — Propagate capability output-schemas through the canvas pipeline (general)

Status: proposed · Scope: `omadia-ui-orchestrator` (generic) + `@omadia/agent-seo-analyst`
(first consumer) · Anchor PR: #277 (`fix/ui-orchestrator-skeleton-fallback`)

> **Design principle (per product owner):** This is a GENERAL solution, not a SEO hack.
> **Agents offer capabilities; the orchestrator consumes them. The only missing piece is
> passing the capability's data schema through the pipeline cleanly.** No per-agent code,
> no kernel boundary change. The SEO Analyst is merely the first capability we make render
> end-to-end.

## Current state (2026-06-10, after the latest deploy)

A canvas turn against the SEO Analyst **now renders** — the On-Page table fills correctly
(Title/Meta/Canonical/H1/… with Status + Wert). **But the top stat-card row is empty**:
`SEO-SCORE`, `MOBILE-FREUNDLICHKEIT`, `PERFORMANCE`, `ZUGÄNGLICHKEIT` show labels, no values.
The table (an **array** → `rows`) maps; the score block (a **scalar object** `score{}`)
has no producer and no mapping target, so it stays blank. That single gap is the whole
problem, and it is generic.

## Why

PR #277 introduced the Tier-2 canvas pipeline. The flow (verified in
`omadia-ui-orchestrator/src/plugin.ts` + `composition.ts`):

1. **Skeleton composition** — one fast-model (Haiku) call (`composeSkeleton`) turns the
   user text into a schema-valid skeleton tree **and** a `dataRequirements` contract
   (containerId + fieldKeys). It selects **no tools**; it only decides the UI shape.
2. **Requirement handoff** — the delegated **main turn is the normal base-orchestrator
   tool loop with the FULL capability set of every plugin** ("The base orchestrator tool
   loop is untouched"), plus a `[canvas-context]` block: "satisfy these dataRequirements,
   then publish via `canvas_publish_rows`".
3. **Synthesis** — `canvas_publish_rows` emits `_pendingStructuredPayload` → a
   deterministic `surface_patch`; a `source` passed on that call is captured as the
   refresh recipe (`ctx.tools.invoke` replays it later with no LLM).

So the orchestrator **already exposes every plugin capability to the main turn** — there
is no capability-access gap, and no "native tool" needs inventing. Yet a live canvas
turn against the SEO Analyst publishes **nothing**.

## Live evidence (2026-06-10, middleware `omadia-test-middleware-1`)

Two back-to-back canvas turns, same session:

| Turn | Path | Result |
|------|------|--------|
| `b9425508` (Dynamics) | main turn calls `dynamics_query` **directly** | `dynamics_query` → **2× `canvas_publish_rows`** → `recipe captured: courses_next_week` ✅ |
| `b66dadc2` (SEO) | main turn calls `query_seo_analyst` (sub-agent) | sub-agent runs `analyze_page` (4795 b) + `check_technical_seo` (1323 b) ok; `query_seo_analyst` returns 6993 b of **text**; plan-runner materialised 5 steps → **0× `canvas_publish_rows`, no recipe** ❌ |

## Diagnosis — the real boundary is integration-tool vs. agent-sub-agent

The split is **not** SEO-specific and **not** about "native vs. non-native" tools. It is
**how the data-fetching capability is reached**:

- **Dynamics** is an *integration* plugin → it contributes **flat tools**
  (`dynamics_query`, `dynamics_fetchxml`) that the main turn calls **directly**. The
  producer + recipe-capture layer therefore *sees* the call and its structured JSON
  result → it can publish rows and record a replayable `RefreshSource.tool`.
- **SEO (and Papierkram)** are *agent* plugins → their capabilities are wrapped behind a
  `query_*` **sub-agent** (`query_seo_analyst`). The sub-agent runs its own nested LLM
  loop, calls `analyze_page` *internally*, and returns **synthesised text**. The canvas
  producer + recipe layer see only that opaque text — **not** the structured
  `SeoPageReport`, **not** the replayable `analyze_page` call.

**→ The canvas Tier-2 producer/refresh layer only observes flat, main-turn-level tool
calls. Work done inside a `query_*` sub-agent is invisible to it.** That is why Dynamics
renders + refreshes and SEO does not. Concrete consequences:

1. **No structured payload to publish.** The main turn holds only the sub-agent's text,
   so it has nothing to hand to `canvas_publish_rows` — and the skeleton's `issues`
   container (if any) never gets filled.
2. **No replayable recipe.** A recipe could only name `query_seo_analyst` + the user-ish
   input → a `canvas_refresh` would re-run the **sub-agent** (LLM in the seat), not the
   deterministic, model-free replay the system promises. The inner `analyze_page` call is
   unreachable to `ctx.tools.invoke`.
3. **Skeleton has no SEO shape anyway.** The composition system prompt's examples are all
   Kurse/Teilnehmer/Dynamics; for an SEO ask it produces a prose/overview skeleton with
   no data-carrying table, so step 2 never even instructs the main turn to publish rows.
4. **Output-shape mismatch downstream.** Even with rows promised, `applyRefreshSource`
   expects a flat record **array** + flat `fieldKey → attribute` map; `SeoPageReport` is
   a nested object (`score{}`, `meta{}`, `issues[]`). Needs a tabular projection.
5. **No chart producer.** `chart` exists only as a composition **node type**
   (`patchComposition.ts:81`); runtime registers two producer tools (rows + choice). SEO
   category scores have no first-class producer path.
6. **Blocked-host = hard throw.** `analyze_page` throws on any host outside the allow-list
   (`omadia.ai`, `*.omadia.ai`) → `turn_error` / stuck skeleton for non-omadia asks.
7. **Public-PR hygiene.** `manifest.yaml` still carries `license: "Proprietary"` + byte5
   copy despite the OSS genericization.

## Root cause (generic)

The capability **already declares its output schema** — `analyze_page.output_schema` in
`manifest.yaml` lists `meta{}`, `headings{}`, `links{}`, `images{}`, `structured_data[]`,
`issues[]`, `score{}`. The data scheme exists. It is simply **never propagated** into the
canvas pipeline, so two things go wrong, both generic:

1. **`composeSkeleton` only receives `userText`** (`composition.ts`: `opts = {llm, model,
   userText, log}`). The skeleton's containers + `fieldKeys` are **invented by the model**,
   not derived from the capability schema. The model happened to guess a plausible
   On-Page table, but the stat-card fieldKeys are imaginary and don't correspond to
   `score{}`'s real keys.
2. **The producer + patch layer is array-only.** `canvas_publish_rows` requires a `rows`
   **array**; `surface_patch` maps "rows onto the skeleton's table columns"
   (`surfaceSynthesis.ts` / `patchComposition.ts`). A **scalar object** (`score{}` → the
   four stat cards) has no producer and no mapping target → "unmappable payloads are
   skipped" → empty top row.

## Approach — pass the schema cleanly, end to end

One general mechanism: **the capability's `output_schema` becomes the field contract that
flows skeleton → handoff → publish → patch.** Every agent capability benefits; SEO is just
the first to exercise it. No `query_*`-vs-integration boundary change, no per-agent code.

### Phase 1 — Schema propagation into composition + handoff (the core fix)
- Thread the selected capability's `output_schema` (already in the manifest, already loaded
  by the kernel as the capability spec) into `composeSkeleton` as a new `opts.outputSchema`
  (or `opts.capabilities[]` when the turn may hit several). The skeleton then **derives
  container fieldKeys + types from the schema**, not from the model's imagination.
- Carry the same schema into the `[canvas-context]` `dataRequirements` handoff so the main
  turn publishes payloads whose keys line up with the skeleton by construction.
- Generic schema→surface convention (in the system prompt, schema-driven, not SEO-worded):
  - `type: array` property → a **table** container (columns = item-object keys).
  - flat scalar group (`type: object` of primitives, e.g. `score{}`) → a **stat-card /
    chart** container (one field per key).
- Files: `composition.ts` (signature + prompt), `plugin.ts` (pass the spec through),
  `surfaceSynthesis.ts` (`dataRequirements` already carried — feed schema-derived ones).

### Phase 2 — A generic non-array producer (fills the stat cards)
- Today only *array→table* (`canvas_publish_rows`) and *choice* exist. Add the missing
  generic path for **scalar/object** data so `score{}` can fill stat-card / chart
  containers. Two options:
  - extend `canvas_publish_rows` to accept an optional `fields: Record<string,scalar>`
    (a degenerate single-record payload mapped to cards/chart), **or**
  - add `canvas_publish_data({containerId, data})` where `data` is validated against the
    container's declared field contract — works for tables, stat groups, and charts alike.
- Extend `surfaceSynthesis`/`patchComposition` to map a payload to its container **by the
  declared field contract** (array→rows OR object→fields), instead of rows-only append.
  This is the generic mapping fix; the empty-top-row bug disappears for any capability.

### Phase 3 — Deterministic refresh (generic, schema-keyed)
- With the schema carried on the publish payload, `RefreshSource` keys off the same
  contract. Whichever tool the main turn actually called (integration tool directly, or an
  agent capability the orchestrator invoked) is recorded as the recipe `tool` + `input`;
  `canvas_refresh` replays it via `ctx.tools.invoke` and maps by the field contract — no
  LLM. Success signal: `[canvas-refresh] deterministic: … (no LLM)` for the SEO container,
  identical to the Dynamics path. (Whether an agent capability is directly invocable by
  `ctx.tools.invoke` for replay is the one wiring detail to confirm; if not, refresh for
  agent-served containers re-runs the capability through its normal path.)

### Phase 4 — SEO consumer correctness (no special-casing)
- Ensure `analyze_page` actually **returns data matching its declared `output_schema`**
  (typed `score{}` keys: `seo`, `mobile`, `performance`, `accessibility` → the four cards),
  so schema propagation has real values to bind. This is the only SEO-side change and it is
  just "make the capability honour its own schema."
- Blocked-host / timeout → return a **structured** "could-not-analyse" result (a notice
  field + a `choice` to widen audit mode) instead of throwing, so the canvas degrades
  gracefully rather than emitting `turn_error`.

### Phase 5 — Public-PR hygiene
- `manifest.yaml`: `license` → `MIT`, genericize description/defaults to match the OSS
  release; keep `omadia.ai` as the example target.

## Validation process (per repo convention)

1. `EnterWorktree` off `fix/ui-orchestrator-skeleton-fallback` (or a follow-up branch).
2. Implement phase-by-phase; **no `npm run build`** — `lint:fix` + `typecheck` only
   (per CLAUDE.md), plus `vitest run` for the touched packages
   (`uiCanvasRefresh.test.ts`, `uiOrchestratorComposition.test.ts`, new SEO toolkit tests).
3. Rebuild + redeploy the **middleware** container; confirm a canvas turn against the SEO
   Analyst now logs (today it logs none of these — see Live evidence):
   - `tool=canvas_publish_rows plugin=@omadia/ui-orchestrator` for the SEO turn (skeleton
     resolves into an `issues` table), and
   - a second `canvas_refresh` → `[canvas-refresh] deterministic: … (no LLM)` naming the
     SEO tool — the exact success signal turn `b9425508` produced for Dynamics.
4. New `operationId`s for any new OpenAPI methods (per CLAUDE.md).
5. Update PR #277 (or open the follow-up PR) with the scope delta; PR/issue text in
   English, commits without the Claude co-author trailer.

## Repo scope — omadia vs. omadia-ui

**The core fix is omadia (middleware) only.** Verified:
- The client applies **generic JSON-Patch by `path`** (`canvasStore.ts`) — it can fill any
  node field. The "array/rows-only" limit lives **server-side** in `patchComposition`, not
  in the renderer.
- The stat cards are built from already-rendered primitives (`container`/`heading`/`text`;
  `status` also renders). No client change is needed to populate them — the server just has
  to emit the value patch.

→ As long as scalar values are patched into **already-rendered** primitives
(`text`/`heading`/`status`), the entire fix ships in **omadia**. Keep Phase 2's producer
targeting these.

**omadia-ui IS required only if** we introduce a primitive the M1 renderer doesn't handle
yet — notably **`chart`** (in the protocol schema, but no `case 'chart'` in
`PrimitiveNode.tsx`), `progress`, or a **new `metric`/scorecard primitive**. Any of these
means: shared protocol schema (defined in omadia) → regenerate the validator
(`npm run gen:validator`) + add a render branch in `PrimitiveNode.tsx` (omadia-ui), and
possibly an ops-catalog version bump. **Recommendation: stay omadia-only** by rendering the
score into text/heading/status cards; defer a dedicated score chart to an explicit
omadia-ui slice.

## Open decisions

- **Non-array producer shape (Phase 2)**: extend `canvas_publish_rows` with an optional
  `fields` object vs. a new generic `canvas_publish_data({containerId, data})`. The latter
  is cleaner long-term (one producer, schema-validated, covers table/stats/chart).
- **Schema selection for composition (Phase 1)**: pass the single routed capability's
  schema, or all candidate capabilities' schemas, into `composeSkeleton`. Start with the
  routed one; widen only if first-paint skeletons suffer.
- **Refresh replay for agent capabilities (Phase 3)**: confirm whether an agent capability
  is invocable via `ctx.tools.invoke` for model-free replay, or whether agent-served
  containers refresh through the normal capability path.
- **Scope on #277 vs. follow-up**: the generic orchestrator changes (Phases 1–3) are a
  clean standalone `feat: schema-driven canvas surfaces` PR; SEO Phases 4–5 ride along as
  the proof consumer.
