# Model gateway: call sites and their execution contexts

Spec 2042 §5.10 and §6 criterion 37, ADR-0017, issue #2053. Every model call
runs in exactly one execution context, which decides whose budget it uses and
what it may do. This page lists every place in `middleware/src` and
`middleware/packages/*/src` that makes a model call, and the context it runs
in on the S3a kernel (expand step). Under `MODEL_GATEWAY_MODE=observe` a call
with no context is admitted and logged once per call site; under `enforce`
(the contract step, S3b) it is refused. The live counterpart of this page is
`GET /api/v1/admin/model-gateway`, which lists the call sites that actually ran
outside a context since boot.

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
| `securityScreener.ts` (`screenInboundTurn`) | complete | AT; **NONE on routine turns** | runs before the routine's turn scope |
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
| `significanceScorer.ts` | complete | AT; OJ:bulk_promotion; **NONE from the scratch reaper** | |
| `topicClustering.ts` | complete | OJ:topic_regrouping | |
| bulk promotion (`routes/bulkPromotion.ts`) | complete, embed | OJ:bulk_promotion | |
| `inconsistencyDetector.ts`, `mergeCandidateDetector.ts` | embed, complete | AT; OJ:memory_review_detection; OJ:memory_edit after memory REST writes; **NONE after reaper writes** | |
| `scratchPromotionReaper.ts` | complete, embed | **NONE** | interval job |
| `topicDetector.ts` | embed, complete | IP when a channel plugin calls `classify` before the turn (`inboundProcessing`) | only consumer: channel-teams |

## Memory and knowledge graph

| Site | Operation | Context | Note |
|---|---|---|---|
| `neonKnowledgeGraph.ts` `embedAndStoreTurn` | embed | AT; **NONE for the boot graph backfill** (`BACKFILL_AT_STARTUP=1`) | |
| `neonKnowledgeGraph.ts` `embedAndStoreNode` | embed | AT or OJ by caller (OJ:memory_edit for `src/routes/memory.ts` writes); **NONE from the reaper** | |
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
| `plugins/routines/routineRunner.ts` | complete | AT, except the screener | |
| `src/platform/pluginContext.ts` `ctx.llm` | complete | the caller's; archetype plugins only ES | **NONE from a plugin's `activate()`, `ctx.jobs` handler or timer** |
| channel plugins' `transcription.transcribeFile`, `topicDetector.classify` | transcribe; embed, complete | IP | `inboundProcessing`; `transcribeStream` is not wrapped |
| `src/mcp/publicMcpServer.ts` tool dispatch | any | **NONE** | |

## Gaps: calls with no context today

Each is admitted and logged in `observe`; each must have a context (or be
removed) before the contract step switches to `enforce`.

| # | Call | Fix owner / plan |
|---|---|---|
| 1 | Scratch-promotion reaper (interval) | S4: unattended work as a batch trigger with caps and circuit breaker; not a maintenance run (it calls `complete`) |
| 2 | Field-classification recompute (boot, activation, 6 h, POST route) | S3b: operator job for the POST route; the scheduled runs as a bounded kernel job (S4 trigger caps) |
| 3 | Security screener on routine turns | S4 (routines become triggers of an agent turn) |
| 4 | Boot graph backfill (`BACKFILL_AT_STARTUP=1`) | S3b: maintenance run like the embedding backfill |
| 5 | Public MCP server tool dispatch | S3b: run each dispatch in the agent turn of the agent the API key is bound to |
| 6 | Long-running sub-agent tasks re-driven at boot / interval | S3b: carry the originating agent turn's context on the task |
| 7 | Plugin Builder auto-fix, smoke, preview refresh, rebuilds | S2 (Plugin Builder): wire `PLUGIN_BUILDER_AUTOFIX` and the preview kinds |
| 8 | Plugin background code (`activate()`, `ctx.jobs`, timers) calling `ctx.llm` / `embeddingClient` | S3b: `ctx.jobs` handlers as maintenance runs or refused; plugin train moves the rest |
| 9 | A channel's `transcribeStream` outside a turn | live sessions run in their execution scope; anything else is refused in `enforce` |
| 10 | Embedding backfill when `maintenanceRun@1` is missing | S3b: refuse the sweep instead of running it without a context |

## Not gated in any mode

- `decisionModel@1` (Jev): the provider lives in `byte5ai/omadia-jev-plugin`,
  not in `GATED_SERVICES`. Plugin train: the Jev plugin becomes a `model` or
  `system-module` and its service passes the gate.
- The GLiNER sidecar (`c1Detector.ts`): a local NER model, no gateway
  operation.
- The raw `anthropicClient` service: a direct `messages.create` skips the
  adapters. Refused to archetype plugins, observed for other plugins, refused
  to all non-`model` plugins in the contract step (channel-teams still
  declares it and must drop it first).
