# Model gateway: call sites and their execution contexts

Spec 2042 §5.10 and §6 criterion 37, ADR-0017, issue #2053. Every model call
runs in exactly one execution context, which decides whose budget it uses and
what it may do. This page lists every place in `middleware/src` and
`middleware/packages/*/src` that makes a model call, and the context it runs
in. Since the contract step (S3b) a call with no context is refused; the S3a
kernel (expand step) admitted and logged it. The live counterpart of this page
is `GET /api/v1/admin/model-gateway`, which lists the call sites refused since
boot. A site is the first frame after the gate, the provider adapters and the kernel bridges every caller of a kind passes through (`platform/anthropicLlmProvider`, `platform/pluginContext`, `withProviderUsageTracking`), so a `ctx.llm` call names the plugin code that made it.

Abbreviations: **AT** agent turn (opened by `withAgentTurnExecution`, the
outermost layer of every agent's chat agent, or by the agent runtime's
`turnContext`), **ES** execution scope (`agentTurn@2`), **IP** inbound
processing, **OJ:x** operator job of kind `x` (`src/platform/modelWorkKinds.ts`),
**MR** maintenance run, **NONE** no context.

Inventory as of 2026-11-20 (branch `feat/2042-s3-plugin-boundary-gateway`).
Line numbers drift; the names are what to search for.

## The gate

| Site | Operation | Note |
|---|---|---|
| `packages/llm-adapter-anthropic/src/anthropicProvider.ts` (`complete`, `stream`) | complete | provider gate; the kernel's `llm` service (`src/platform/anthropicLlmProvider.ts`) and every `ctx.llm` build on these adapters |
| `packages/llm-adapter-openai/src/openaiProvider.ts`, `llm-adapter-openai-responses/src/responsesProvider.ts` | complete | |
| `src/platform/claudeCliAdapter.ts` | complete | single-shot CLI provider |
| `packages/harness-orchestrator/src/cliChatAgent.ts` | run_loop | CLI-owned loop |
| `src/platform/modelGatewayServices.ts` (`gateModelService`) | embed, transcribe | wraps `embeddingClient.embed` and `transcription.transcribeFile` / `transcribeStream` for every consumer |

## Agent runtime (`harness-orchestrator`)

| Site | Operation | Context | Note |
|---|---|---|---|
| `streaming.ts` (`completeWithFallback`, stream) from `orchestrator.ts` and `localSubAgent.ts` | complete | AT | main loop, sub-agents, dynamic agents; routine turns through the ambient `turnContext` |
| `orchestrator.ts` `maybeRouteCardsFromText`, `maybeDirectLineNote`; `modelRouter.ts`, `personaRouter.ts` | complete | AT | |
| `securityScreener.ts` (`screenInboundTurn`) | complete | AT | on routine turns through the running agent's turn (`routineRunner.ts` `runOnce`, scheduled or "run now") |
| `cliChatAgent.ts`, `cliSubAgent.ts` | run_loop | AT (OJ for the Plugin Builder) | |
| `orchestrator.ts` `recallCliContext`, `recordCliTurn` | embed, complete | AT | |
| `knowledgeGraphTool.ts` | embed | AT; **NONE through the public MCP server** | |
| `tools/transcribeRecordingTool.ts` | transcribe | AT | |
| `sessionLogger.ts` → `ingestTurn` | embed, complete | AT | |
| `tasks/subAgentTaskTool.ts` | complete | AT inline; **NONE when re-driven by the resume driver** | only with `LONG_RUNNING_SUBAGENT_TOOLS` |

## Verifier, fast lane, plan runner

| Site | Operation | Context | Note |
|---|---|---|---|
| `harness-verifier/src/claimExtractor.ts`, `evidenceJudge.ts` | complete | AT | after the loop, inside the wrapper |
| `harness-plugin-fast-path/src/router.ts`, `planner.ts` (`ctx.llm`) | complete | AT | |
| `harness-plugin-plan-runner/src/gate.ts`, `materializer.ts`, `stepMapper.ts`, `replanner.ts`, `gc.ts` (`ctx.llm`) | complete | AT | turn hooks |
| `evidenceDecision.ts`, `decisionRouter.ts`, `turnGate.ts`, `recallRelevanceJudge.ts`, `significanceScorer.ts` (`decideAll` / `choose`) | `decisionModel@1` | AT, **not gated** | see "Not gated" |

## Orchestrator-extras (memory learning)

| Site | Operation | Context | Note |
|---|---|---|---|
| `factExtractor.ts`, `excerptExtractor.ts`, `sessionSummaryGenerator.ts`, `recallRelevanceJudge.ts`, `promoteDurableRule.ts` | complete, embed | AT | |
| `contextRetriever.ts` | embed | AT | |
| `significanceScorer.ts` | complete | AT (the scratch reaper's batch trigger too); OJ:bulk_promotion | |
| `topicClustering.ts` | complete | OJ:topic_regrouping | |
| bulk promotion (`routes/bulkPromotion.ts`) | complete, embed | OJ:bulk_promotion | |
| `inconsistencyDetector.ts`, `mergeCandidateDetector.ts` | embed, complete | AT (after reaper writes too); OJ:memory_review_detection; OJ:memory_edit after memory REST writes | |
| `scratchPromotionReaper.ts` | complete, embed | AT | a batch job (`batchJobRegistry@1`), run only by the agent's batch trigger; the firing is that agent's turn |
| `topicDetector.ts` | embed, complete | IP when a channel plugin calls `classify` before the turn (`inboundProcessing`) | only consumer: channel-teams |

## Memory and knowledge graph

| Site | Operation | Context | Note |
|---|---|---|---|
| `neonKnowledgeGraph.ts` `embedAndStoreTurn` | embed | AT; **NONE for the boot graph backfill** (`BACKFILL_AT_STARTUP=1`) | |
| `neonKnowledgeGraph.ts` `embedAndStoreNode` | embed | AT or OJ by caller (OJ:memory_edit for `src/routes/memory.ts` writes; AT from the reaper) | |
| `processMemoryStore.ts` | embed | AT | |
| `embeddingBackfill.ts` | embed | MR (`maintenanceRun@1`); **NONE if that service is missing** | |

## Privacy

| Site | Operation | Context | Note |
|---|---|---|---|
| privacy-guard `v4/piiClassifier.ts` | complete | AT | |
| `v4/modelClassifier.ts` via `src/privacy/fieldClassification/recompute.ts` | complete | **NONE** | boot, activation, 6 h interval, `POST …/privacy/field-classification/recompute` |
| `c1Detector.ts` (GLiNER sidecar) | – | not gated | not a gateway operation |

## Admin, builders, entry points

| Site | Operation | Context | Note |
|---|---|---|---|
| `src/routes/memory.ts` `POST /`, `PATCH /:id`, `PATCH /:id/excerpts/:position` | embed, complete | OJ:memory_edit | the writing user is the job's actor |
| `src/issues/issueReformulator.ts` | complete | OJ:issue_preview | |
| `src/services/skillVerdictLlmVerifier.ts` | complete | OJ:skill_verification | |
| Plugin Builder `builderAgent.ts` (`builderChat.ts`) | complete, run_loop | OJ:plugin_builder_turn | |
| Plugin Builder preview (`previewChatService.ts`, `previewRuntime.ts`) | complete | OJ:plugin_builder_preview | |
| Plugin Builder `autoFixOrchestrator.ts`, runtime smoke, preview refresh, rebuilds | complete, run_loop | **NONE or inherited** | `PLUGIN_BUILDER_AUTOFIX` is defined, not wired |
| Conductor `builderAgent.ts` | complete | OJ:workflow_designer_turn with AT nested | |
| Conductor steps, schedules, `routes/chat.ts`, `orchestratorDispatcher.ts` | complete | AT | through the agent's chat agent |
| `agents/agentTurnService.ts` (`agentTurn@2`) | complete | ES with AT nested | |
| `plugins/routines/routineRunner.ts` | complete | AT | every run (scheduled through its trigger, or "run now" from the route or a chat action) is the turn of the agent that runs it, screener and emitter included |
| `src/platform/pluginContext.ts` `ctx.llm` | complete | the caller's; archetype plugins only ES | **NONE from a plugin's `activate()`, `ctx.jobs` handler or timer** |
| channel plugins' `transcription.transcribeFile`, `topicDetector.classify` | transcribe; embed, complete | IP | `inboundProcessing`; `transcribeStream` is not wrapped |
| `src/mcp/publicMcpServer.ts` tool dispatch | any | AT | the turn of the agent the API key is bound to (S3b) |
| `src/platform/modelPassthrough.ts` `forwardAnthropicMessages` (dev platform's coding jobs) | complete | OJ:`<plugin>:<kind>` (`operatorJobs@1`) | the system module's proxy, no provider key of its own |

## Gaps: calls with no context today

Since the contract step (S3b) the gateway enforces: a call with no context is
refused and listed at `GET /api/v1/admin/model-gateway`.

| # | Call | Fix owner / plan |
|---|---|---|
| 1 | ~~Scratch-promotion reaper (interval)~~ | Done (S4): a batch trigger with caps and circuit breaker; every trigger firing runs in its agent's turn context. Not a maintenance run, because it calls `complete` |
| 2 | ~~Field-classification recompute (boot, activation, 6 h, POST route)~~ | Done (S3b): every pass is one operator job `privacy_field_classification` (200 calls, 15 min), started by `system:auto-classifier`. Seen live in observe mode: one call per plugin activation |
| 3 | ~~Security screener on routine turns~~ | Done (S4): a routine run, scheduled or "run now", is the turn of the agent that runs it (`runOnce`); a scheduled one also runs inside its trigger firing |
| 4 | ~~Boot graph backfill (`BACKFILL_AT_STARTUP=1`)~~ | Done (S3b): one maintenance run `graph_backfill` (embed only), started by `system:boot` |
| 5 | ~~Public MCP server tool dispatch~~ | Done (S3b): each call runs in the agent turn of the agent the API key is bound to |
| 6 | ~~Long-running sub-agent tasks re-driven at boot / interval~~ | Done (S3b): `<tool>_start` stores its turn's context (kind, owner, agent) with the task input; the runner executes in it, fresh or re-driven. A task stored before has none and fails |
| 7 | ~~Plugin Builder auto-fix, runtime smoke~~ | Done (S3b): each auto-fix turn is an operator job `plugin_builder_autofix`, each smoke run one `plugin_builder_preview`. Preview refresh and rebuilds make no model call of their own; a draft's `activate()` that does is gap 8 |
| 8 | Plugin background code (`activate()`, `ctx.jobs`, timers) calling `ctx.llm` / `embeddingClient` | Refused (S3b, by design): background code has no context. Index upkeep goes through `maintenanceRun@1` (embed only), as the knowledge graph's sweep does |
| 9 | A channel's `transcribeStream` outside a turn | Refused (S3b, by design): live sessions run in their execution scope |
| 10 | ~~Embedding backfill when `maintenanceRun@1` is missing~~ | Done (S3b): the sweep is not run, the tick logs why |

## Gated since S3b

- `decisionModel@1` (Jev, a `model` plugin): `choose` and `decideAll` pass the
  gate as `complete` in the caller's context (`GATED_SERVICES`).

## Not gated

- The GLiNER sidecar (`c1Detector.ts`): a local NER model, no gateway
  operation.
- The raw `anthropicClient` service is refused to every plugin but model
  plugins and the kernel's own system modules (S3b); none of them calls it
  outside the adapters.