# Deterministic Agent UI — instant, LLM-free canvas from any plugin

> Status: **shipped** (kernel + orchestrator), verified live 2026-06-12.
> Scope: a generic contract so *any* agent plugin can ship deterministic UI
> (instant, no model turn) **or** stay data-driven and use the compose path.

## The idea

An agent's canvas interaction splits into two fundamentally different modes:

1. **Generative** — the model must *create* the view from data it just fetched
   or reasoned about (the variant cards, a one-off summary table). The shape is
   not known ahead of time. This is the compose/skeleton path — *the real magic
   of Omadia UI*: the orchestrator composes a skeleton, the agent fills it, the
   model decides the layout.

2. **Deterministic** — the result is **fully determined by the plugin**. A
   saved-page recall, a status flip, a stored list view, a wizard form. There is
   nothing for a model to decide; the plugin already holds the answer in its
   application layer. Routing these through an LLM turn is pure latency + cost.

This contract makes mode (2) a first-class, declarative capability. An agent
opts a tool into the deterministic fast-path; the orchestrator then dispatches
that tool **directly** when a canvas action names it — no skeleton, no
sub-agent, no model turn. Measured dispatch on the first consumer
(`x_studio_load_page`): **~4 ms**.

## How an agent declares it

Two manifest flags on a capability, both autodiscovered (no operator config):

```yaml
capabilities:
  - id: "x_studio_load_page"
    canvas_output: true          # may EMIT a canvas surface (_pendingCanvasTree / _pendingSurfacePatch)
    deterministic_action: true   # result is plugin-determined → dispatch LLM-free
```

- `canvas_output: true` → `CanvasOutputRegistry` authorises the tool's sentinel.
- `deterministic_action: true` → `DeterministicActionRegistry` marks it
  fast-path eligible.

Both are **deny-by-default** and **declare → resolve → derive**: the plugin
declares, the kernel resolves on (de)activation, the orchestrator derives its
allow-set lazily per check. A tool reaches the fast-path only when it declares
**both** (emit a surface *and* be deterministic). The orchestrator's
`deterministic_action_tools` config field remains an operator override on top.

Data-driven agents simply omit `deterministic_action` — they keep using the
compose path. Same plugin can mix: some tools generative, some deterministic.

## How a canvas action triggers it

A primitive carries an action, e.g. a nav button:

```ts
{ type: 'button', label: 'Drafts',
  action: { type: 'x_studio_load_page', payload: { page: 'drafts' }, effect: 'internal' } }
```

When the client sends that action turn, the orchestrator's `canvasTurnStream`
checks, *before* the in-place/skeleton paths:

```
action.type ∈ deterministicActionTools?
  → invoke the tool DIRECTLY with action.payload
  → feed its sentinel through synthesizeSurfaceEvents (synthetic tool_use/tool_result)
  → surface_snapshot / surface_patch, no model anywhere
```

## The two-source invoker (the crux)

Tools live in two places, so dispatch tries both in order:

1. **Native registry** (`ctx.tools.invoke`) — integration tools
   (`dynamics_fetchxml`, …) and the orchestrator's own producer tools. Top-level.
2. **`agentToolInvoker` service** (NEW) — **agent-plugin** tools. These live
   *inside* the `query_<domain>` sub-agent, not the native registry, so
   `ctx.tools.invoke` misses them. `agentToolInvoker.invoke(toolId, input)`
   resolves the owning active agent in `DynamicAgentRuntime` and runs that one
   bridged tool handler directly — **invoke-only**: it deliberately does NOT add
   the tool to the main orchestrator's offered-tool list, so agent isolation
   holds (the main model still can't call agent internals; only a
   deterministic, user-initiated action can, and only for declared tools).

> This two-source design is *why* the first naïve implementation failed live:
> the unit test faked `ctx.tools.invoke` and resolved the tool; only the live
> run exposed that agent-plugin tools aren't in the native registry. The
> `agentToolInvoker` closes that gap generically.

## Components (shipped)

| Layer | File | Role |
|------|------|------|
| Registry | `middleware/src/platform/deterministicActionRegistry.ts` | autodiscover `deterministic_action: true` (sibling of `canvasOutputRegistry`) |
| Runtime | `middleware/src/plugins/dynamicAgentRuntime.ts` | register ids on activate; `invokeAgentTool(toolId, input)` runs one bridged tool directly |
| Wiring | `middleware/src/index.ts` | provide `deterministicActionRegistry` + `agentToolInvoker` services |
| Orchestrator | `packages/omadia-ui-orchestrator/src/plugin.ts` | deterministic branch: native invoke → `agentToolInvoker` fallback |
| Consumer | `omadia-x-studio` (`load_page`, nav shell) | first agent shipping a deterministic UI |

## Authoring a deterministic UI in a new agent (recipe)

1. Add a toolkit tool that returns `{ _pendingCanvasTree: { tree } }` (or a
   `_pendingSurfacePatch`) computed purely from plugin/application state.
2. Declare it `canvas_output: true` **and** `deterministic_action: true`.
3. Author canvas trees whose buttons carry `action: { type: '<that tool>', payload }`.
4. (Optional) Wrap views in a persistent nav shell so navigation is omnipresent
   — see X-Studio's `pageShell` / `navRail`.

That's it — no kernel change per agent. Generative tools need none of this; they
stay on the compose path.

## Verified

- Unit: orchestrator dispatches deterministic actions LLM-free; deny-by-default
  fall-through; **native-miss → `agentToolInvoker` fallback** (21/21).
- Live (CDP, real authenticated socket): nav click → `tool:load_page` runs →
  `[deterministic-action] x_studio_load_page dispatched LLM-free in 4ms (no
  model turn)` → canvas renders the Drafts page with the nav rail (active
  marker), no remount of an LLM-composed skeleton.

## Follow-ups

- Make a `surface_patch`-only deterministic action update in place without a
  full snapshot (status chips already do this; generalise for nav where only a
  sub-tree changes).
- User-saved pages (phase 2): persist arbitrary canvas states per user; nav
  lists them. Same fast-path, a `DraftStore`-style page store behind it.
