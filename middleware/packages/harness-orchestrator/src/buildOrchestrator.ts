/**
 * Per-Agent Orchestrator construction (US3).
 *
 * `buildOrchestratorForAgent` is the parameterized factory that builds one
 * `Orchestrator` — plus its optional verifier wrapper and its `chatAgent`
 * bundle — for a named Agent. The orchestrator plugin's `activate()` calls it
 * once for the default Agent; the multi-orchestrator registry (US4) calls it
 * once per configured Agent.
 *
 * The process-shared services are resolved once by the caller and passed in
 * via `OrchestratorDeps`; only the per-Agent knobs in `AgentRuntimeConfig`
 * differ between calls. The factory is pure construction — no service
 * registration, no process-global side effects — so it is safe to call more
 * than once in one process.
 */

import type { ChatAgent } from '@omadia/channel-sdk';
import type { EmbeddingClient } from '@omadia/embeddings';
import type { LlmProvider } from '@omadia/llm-provider';
import type {
  ContextRetriever,
  FactExtractor,
} from '@omadia/orchestrator-extras';
import type {
  EntityRefBus,
  KnowledgeGraph,
  MemorableKind,
  MemoryStore,
  NudgeRegistry,
  NudgeStateStore,
  PalaiaExcerptExtractor,
  PrivacyGuardService,
  ProcessMemoryService,
  ResponseGuardService,
  SessionBriefingService,
} from '@omadia/plugin-api';
import type { VerifierBundle } from '@omadia/verifier';
import type { Pool } from 'pg';

import { MemoryToolHandler } from '@omadia/memory';

import { ChatSessionStore } from './chatSessionStore.js';
import type { Microsoft365Accessor } from './microsoft365-shim.js';
import type { NativeToolRegistry } from './nativeToolRegistry.js';
import type { ModelRoutingConfig } from './modelRouter.js';
import { Orchestrator } from './orchestrator.js';
import { CliChatAgent } from './cliChatAgent.js';
import { ToolDispatchService } from './toolDispatchService.js';
import { OrchestratorMemoryNamespacer } from './orchestratorMemoryNamespacer.js';
import { DurableRulesMemoryStore } from './durableRulesMemoryStore.js';
import {
  ScopedMemoryStore,
  orchestratorMemoryScope,
} from './registry/scopedMemoryStore.js';
import type { TurnHookRunner } from './turnHooks.js';
import type { ChatAgentBundle } from './plugin.js';
import { SessionLogger } from './sessionLogger.js';
import { AskUserChoiceTool } from './tools/askUserChoiceTool.js';
import { BookMeetingTool } from './tools/bookMeetingTool.js';
import { ChatParticipantsTool } from './tools/chatParticipantsTool.js';
import { FindFreeSlotsTool } from './tools/findFreeSlotsTool.js';
import { SuggestFollowUpsTool } from './tools/suggestFollowUpsTool.js';
import type { AttachmentReader } from './tools/readAttachmentTool.js';
import { VerifierService } from './verifierService.js';

/**
 * The per-Agent knobs — everything that differs between two Agents built in
 * the same process.
 */
export interface AgentRuntimeConfig {
  /** Stable id of the Agent (orchestrator instance) being built. */
  readonly agentId: string;
  readonly model: string;
  /** Optional per-turn Sonnet/Opus routing (see {@link OrchestratorOptions}). */
  readonly modelRouting?: ModelRoutingConfig;
  readonly maxTokens: number;
  readonly maxToolIterations: number;
  /** Optional round-loop guard thresholds (see {@link OrchestratorOptions}). */
  readonly loopRepeatSoft?: number;
  readonly loopRepeatHard?: number;
  /** Optional per-turn wall-clock budget in seconds (0 / omitted = off). */
  readonly maxTurnSeconds?: number;
}

/**
 * Process-shared dependencies — resolved once by the caller and reused across
 * every Agent built in the process. The required services are guaranteed
 * present by the caller (the plugin's `activate()` guards them before
 * building).
 */
export interface OrchestratorDeps {
  readonly provider: LlmProvider;
  readonly knowledgeGraph: KnowledgeGraph;
  readonly memoryStore: MemoryStore;
  readonly entityRefBus: EntityRefBus;
  readonly nativeToolRegistry: NativeToolRegistry;
  readonly nudgeRegistry: NudgeRegistry;
  /** Late-bound `responseGuard@1` lookup (see `OrchestratorOptions`). */
  readonly responseGuard: () => ResponseGuardService | undefined;
  /** Late-bound `privacy.redact@1` lookup (see `OrchestratorOptions`). */
  readonly privacyGuard: () => PrivacyGuardService | undefined;
  /**
   * Slice 2.5 — cross-plugin runtime-config lookup for the privacy bypass
   * resolver (see `OrchestratorOptions.pluginConfigGet`). Wired from the
   * harness runtime that owns the installed-plugin registry. Optional —
   * when absent, only kernel-tool bypass works.
   */
  readonly pluginConfigGet?: (
    agentId: string,
    configKey: string,
  ) => unknown | undefined;
  readonly contextRetriever?: ContextRetriever;
  readonly sessionBriefing?: SessionBriefingService;
  readonly factExtractor?: FactExtractor;
  readonly excerptExtractor?: PalaiaExcerptExtractor;
  readonly embeddingClient?: EmbeddingClient;
  readonly microsoft365?: Microsoft365Accessor;
  readonly verifierBundle?: VerifierBundle;
  readonly nudgeStateStore?: NudgeStateStore;
  readonly processMemory?: ProcessMemoryService;
  /** Merged from main 2026-05-26: KG-ACL auto-promotion env flags. */
  readonly autoPromote?: boolean;
  readonly autoPromoteThreshold?: number;
  /** Trigger T3 — durable auto-promotion. Threaded here so dynamic / registry
   *  agents self-curate the durable tier too (not just the static chatAgent@1).
   *  Undefined → durable auto-promotion off for this agent. */
  readonly autoPromoteDurableMinSignificance?: number;
  readonly autoPromoteDurableKinds?: MemorableKind[];
  /** Shared Postgres pool the Orchestrator may use for direct KG writes. */
  readonly graphPool?: Pool;
  readonly graphTenantId?: string;
  /** Operator-set assistant identity (overrides the built-in default). */
  readonly assistantIdentity?: string;
  /** #133 E0 — side-channel turn-hook runner, fired during each turn. */
  readonly turnHookRegistry?: TurnHookRunner;
  /**
   * #268 — byte source for user-uploaded attachments. When present, the
   * orchestrator auto-ingests document text and exposes `read_attachment`.
   * Built kernel-side over the shared S3/Tigris bucket. Optional — absent →
   * both attachment-reading mechanisms stay inert.
   */
  readonly attachmentReader?: AttachmentReader;
}

/** What one `buildOrchestratorForAgent` call produces. */
export interface BuiltOrchestrator {
  readonly orchestrator: Orchestrator;
  /** The `chatAgent` bundle — verifier-wrapped agent + raw orchestrator. */
  readonly bundle: ChatAgentBundle;
}

/**
 * Build one Agent's `Orchestrator`, its optional verifier wrapper, and its
 * `chatAgent` bundle. Each call produces a fully independent instance set —
 * no mutable state is shared between two calls.
 */
export function buildOrchestratorForAgent(
  config: AgentRuntimeConfig,
  deps: OrchestratorDeps,
): BuiltOrchestrator {
  // Per-orchestrator memory isolation. The shared kernel `MemoryStore` is
  // wrapped so this Agent can only touch its own tree (`orchestrator:<slug>:*`)
  // plus the shared `core` namespace — enforced by `ScopedMemoryStore`.
  //   - ChatSessionStore + SessionLogger write to the shared `core`
  //     `sessions`/`chat-sessions` paths (session transcripts stay common,
  //     decision A3a), so they use the scoped store directly.
  //   - The model-facing `memory` tool additionally goes through the
  //     namespacer, which rewrites its arbitrary `/memories/<x>` notes into
  //     the Agent-private `/memories/orchestrators/<slug>/<x>` tree.
  const scopedStore = new ScopedMemoryStore({
    agentSlug: config.agentId,
    scope: orchestratorMemoryScope(config.agentId),
    inner: deps.memoryStore,
  });
  const chatSessionStore = new ChatSessionStore(scopedStore);
  const sessionLogger = new SessionLogger(
    scopedStore,
    deps.knowledgeGraph,
    chatSessionStore,
    config.agentId,
  );
  // Trigger T1 — durable-rules live hook. Wrap the (shared-passthrough)
  // namespacer so writes to `/memories/_rules/` auto-promote into curated
  // durable MemorableKnowledge. Needs the graph pool; gated off when absent or
  // via KG_DURABLE_RULES_HOOK=false. Decorator sits OUTSIDE the namespacer so
  // it sees the model-facing `_rules/` path (namespacer passes `_` through).
  const namespacedStore: MemoryStore = new OrchestratorMemoryNamespacer(
    config.agentId,
    scopedStore,
  );
  const durableRulesHookEnabled =
    process.env['KG_DURABLE_RULES_HOOK'] !== 'false' && !!deps.graphPool;
  const memoryToolStore: MemoryStore = durableRulesHookEnabled
    ? new DurableRulesMemoryStore(namespacedStore, {
        pool: deps.graphPool!,
        kg: deps.knowledgeGraph,
        tenantId: deps.graphTenantId ?? 'default',
        ...(deps.embeddingClient
          ? { embeddingClient: deps.embeddingClient }
          : {}),
        log: (msg): void => {
          console.error(msg);
        },
      })
    : namespacedStore;
  const memoryToolHandler = new MemoryToolHandler(memoryToolStore);

  // Native-tool instances (channel-coupled UI cards + calendar). The calendar
  // tools are present only when the Microsoft 365 accessor is available.
  const chatParticipantsTool = new ChatParticipantsTool();
  const askUserChoiceTool = new AskUserChoiceTool();
  const suggestFollowUpsTool = new SuggestFollowUpsTool();
  const findFreeSlotsTool = deps.microsoft365
    ? new FindFreeSlotsTool(
        deps.microsoft365.obo,
        deps.microsoft365.calendar,
        deps.microsoft365.slots,
      )
    : undefined;
  const bookMeetingTool = deps.microsoft365
    ? new BookMeetingTool(
        deps.microsoft365.obo,
        deps.microsoft365.calendar,
        deps.microsoft365.slots,
      )
    : undefined;

  // domainTools is intentionally empty at construct — sub-agents self-register
  // post-activate via `dynamicAgentRuntime.attachOrchestrator(bundle.raw)`.
  const orchestrator = new Orchestrator({
    agentId: config.agentId,
    provider: deps.provider,
    model: config.model,
    ...(config.modelRouting ? { modelRouting: config.modelRouting } : {}),
    maxTokens: config.maxTokens,
    maxToolIterations: config.maxToolIterations,
    ...(config.loopRepeatSoft !== undefined
      ? { loopRepeatSoft: config.loopRepeatSoft }
      : {}),
    ...(config.loopRepeatHard !== undefined
      ? { loopRepeatHard: config.loopRepeatHard }
      : {}),
    ...(config.maxTurnSeconds !== undefined
      ? { maxTurnSeconds: config.maxTurnSeconds }
      : {}),
    domainTools: [],
    nativeToolRegistry: deps.nativeToolRegistry,
    memoryToolHandler,
    sessionLogger,
    entityRefBus: deps.entityRefBus,
    knowledgeGraph: deps.knowledgeGraph,
    ...(deps.contextRetriever
      ? { contextRetriever: deps.contextRetriever }
      : {}),
    ...(deps.sessionBriefing ? { sessionBriefing: deps.sessionBriefing } : {}),
    ...(deps.factExtractor ? { factExtractor: deps.factExtractor } : {}),
    ...(deps.excerptExtractor ? { excerptExtractor: deps.excerptExtractor } : {}),
    chatParticipantsTool,
    askUserChoiceTool,
    suggestFollowUpsTool,
    ...(findFreeSlotsTool ? { findFreeSlotsTool } : {}),
    ...(bookMeetingTool ? { bookMeetingTool } : {}),
    ...(deps.embeddingClient ? { embeddingClient: deps.embeddingClient } : {}),
    responseGuard: deps.responseGuard,
    privacyGuard: deps.privacyGuard,
    ...(deps.pluginConfigGet
      ? { pluginConfigGet: deps.pluginConfigGet }
      : {}),
    nudgeRegistry: deps.nudgeRegistry,
    ...(deps.nudgeStateStore ? { nudgeStateStore: deps.nudgeStateStore } : {}),
    ...(deps.processMemory ? { nudgeProcessMemory: deps.processMemory } : {}),
    ...(deps.autoPromote !== undefined ? { autoPromote: deps.autoPromote } : {}),
    ...(deps.autoPromoteThreshold !== undefined
      ? { autoPromoteThreshold: deps.autoPromoteThreshold }
      : {}),
    ...(deps.autoPromoteDurableMinSignificance !== undefined
      ? {
          autoPromoteDurableMinSignificance:
            deps.autoPromoteDurableMinSignificance,
        }
      : {}),
    ...(deps.autoPromoteDurableKinds !== undefined
      ? { autoPromoteDurableKinds: deps.autoPromoteDurableKinds }
      : {}),
    ...(deps.graphPool ? { graphPool: deps.graphPool } : {}),
    ...(deps.graphTenantId ? { graphTenantId: deps.graphTenantId } : {}),
    ...(deps.assistantIdentity
      ? { assistantIdentity: deps.assistantIdentity }
      : {}),
    ...(deps.turnHookRegistry
      ? { turnHookRegistry: deps.turnHookRegistry }
      : {}),
    ...(deps.attachmentReader
      ? { attachmentReader: deps.attachmentReader }
      : {}),
  });

  // #309 Shape 3: a tool-less subscription-CLI provider (`claude-cli`) CANNOT
  // drive the in-process tool loop (its `stream()`/`complete()` reject any
  // request carrying tools). Swap the agent for the CLI agent-runtime, where the
  // official `claude` CLI owns the loop and reaches omadia's tools via the
  // loopback MCP server. Done HERE — the single factory the default chatAgent
  // path AND the US4 registry both call — so every chat surface (web-ui canvas,
  // channels) routes to the CLI runtime, not just the default service. The raw
  // Orchestrator is still built + returned (sub-agents attach to it post-activate;
  // exposing those to the CLI dispatch is a follow-up — native tools work now).
  if (deps.provider?.id === 'claude-cli') {
    // Security note (P2-2): the subscription CLI sees the FULL native tool
    // registry via the loopback MCP server, with no allowlist beyond MCP
    // server scoping; a per-agent tool allowlist is a follow-up.
    const dispatch = new ToolDispatchService({
      nativeTools: deps.nativeToolRegistry,
      // Live read: sub-agents (ask_<slug>) attach to `orchestrator` post-activate,
      // so the CLI reaches them over the loopback bridge. A sub-agent's own loop
      // still runs in-process on the tool-less claude-cli provider, so tool-using
      // sub-agents fail GRACEFULLY (dispatch returns an error result) until they
      // also run on the CLI (recursive Shape 3 — follow-up); tool-less ones work.
      domainToolsProvider: () => orchestrator.listDomainTools(),
    });
    return {
      orchestrator,
      bundle: {
        agent: new CliChatAgent({
          dispatch,
          model: config.model.replace(/-cli$/, '') || 'sonnet',
          ...(deps.assistantIdentity
            ? { systemPrompt: deps.assistantIdentity }
            : {}),
        }),
        raw: orchestrator,
        sessionLogger,
        chatSessionStore,
      },
    };
  }

  // Verifier wrapper — only when the `verifier@1` capability is published.
  // Without it the bare Orchestrator IS the chatAgent.
  let agent: ChatAgent = orchestrator;
  if (deps.verifierBundle) {
    agent = new VerifierService({
      orchestrator,
      pipeline: deps.verifierBundle.pipeline,
      ...(deps.verifierBundle.store
        ? { store: deps.verifierBundle.store }
        : {}),
      enabled: true,
      mode: deps.verifierBundle.mode,
      maxRetries: deps.verifierBundle.maxRetries,
      ...(deps.turnHookRegistry
        ? { turnHookRegistry: deps.turnHookRegistry }
        : {}),
    });
  }

  return {
    orchestrator,
    bundle: { agent, raw: orchestrator, sessionLogger, chatSessionStore },
  };
}
