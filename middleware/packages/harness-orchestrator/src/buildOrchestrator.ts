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

import type { ChatAgent, DisclosureSeenStore, GrantStore } from '@omadia/channel-sdk';
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
  TurnReceiptStore,
} from '@omadia/plugin-api';
import type { VerifierBundle } from '@omadia/verifier';
import type { Pool } from 'pg';

import { MemoryToolHandler } from '@omadia/memory';

import { ChatSessionStore } from './chatSessionStore.js';
import type { Microsoft365Accessor } from './microsoft365-shim.js';
import type { NativeToolRegistry } from './nativeToolRegistry.js';
import type { ModelRoutingConfig } from './modelRouter.js';
import {
  Orchestrator,
  type OrchestratorPersonaSkill,
  type AiDisclosureSetup,
} from './orchestrator.js';
import {
  LlmScreener,
  HttpProxyScreener,
  type SecurityScreener,
  type SecurityPostureSetup,
  type SecurityAuditEvent,
} from './securityScreener.js';
import type { DirectLineStickyStore } from './directLineSticky.js';
import type {
  McpInputReplayer,
  PendingMcpInputStore,
} from './mcp/pendingMcpInput.js';
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
  /** #445 — sticky Direct Line for this Agent (see {@link OrchestratorOptions}). */
  readonly directLineSticky?: boolean;
  /** Wave 8 — this Agent's direct-answer persona-skill candidates, resolved
   *  by the caller from `agent_persona_skills` (see {@link OrchestratorOptions}).
   *  Per-agent, unlike the platform-shared `OrchestratorDeps` fields below. */
  readonly personaSkills?: readonly OrchestratorPersonaSkill[];
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
  /**
   * #445 — process-shared sticky Direct Line binding store. Deps, not
   * per-Agent config, because the registry REPLACES an Orchestrator instance
   * on any config diff: a per-instance store would silently unbind every live
   * conversation whenever an operator tweaked something unrelated.
   */
  readonly directLineStickyStore?: DirectLineStickyStore;
  /**
   * W2-1 (#544) — process-shared MCP pending-input store + replayer.
   *
   * Deps, not per-Agent config, for the SAME reason as
   * `directLineStickyStore`: the registry replaces an Orchestrator instance on
   * any config diff, and a per-instance store would drop every parked call
   * whenever an operator changed something unrelated — after the user had
   * already seen the card. Must be the same store instance the kernel's
   * `McpManager` writes to.
   */
  readonly pendingMcpInput?: PendingMcpInputStore;
  readonly mcpInputReplay?: McpInputReplayer;
  /** Late-bound `responseGuard@1` lookup (see `OrchestratorOptions`). */
  readonly responseGuard: () => ResponseGuardService | undefined;
  /** Late-bound `privacy.redact@1` lookup (see `OrchestratorOptions`). */
  readonly privacyGuard: () => PrivacyGuardService | undefined;
  /** #757 — late-bound persistent per-turn receipt store lookup (see
   *  `OrchestratorOptions.turnReceiptStore`). Optional: absent ⇒ receipts
   *  stay ephemeral. */
  readonly turnReceiptStore?: () => TurnReceiptStore | undefined;
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
  /**
   * Issue #474 — per-plugin tool-readiness gate (see
   * `OrchestratorOptions.isPluginToolsReady`). Wired from the harness
   * runtime's `PluginStatusRegistry`. Optional — when absent every
   * plugin's tools are always available (pre-#474 behaviour).
   */
  readonly isPluginToolsReady?: (agentId: string) => boolean;
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
  /**
   * AI-Act Art. 50 (#644) — resolved operator disclosure config. Absent → the
   * shipping default (standard, active) on every channel. See
   * `OrchestratorOptions.aiDisclosure`.
   */
  readonly aiDisclosure?: AiDisclosureSetup;
  /**
   * #644 — process-shared first-turn-per-scope fold-dedup store. Deps, not
   * per-Agent config, for the SAME reason as `directLineStickyStore`: the
   * registry replaces an Orchestrator instance on any config diff, and a
   * per-instance store would re-fold the marking into every live conversation
   * whenever an operator changed something unrelated.
   */
  readonly aiDisclosureSeenStore?: DisclosureSeenStore;
  /**
   * #579 — resolved org security posture (org floor + optional scope tighten +
   * shadow/enforce mode + optional external screen URL). Absent → the shipping
   * default (`auto`, enforce). The SCREENER and AUDIT SINK are built here (they
   * need the provider + session logger), keyed off this setup — see
   * `OrchestratorOptions.securityScreener` / `securityAuditSink`.
   */
  readonly securityPosture?: SecurityPostureSetup;
  /**
   * #575 — durable capability grants for the audience floor.
   *
   * Present ONLY when the operator enabled the floor: the kernel publishes the
   * `audienceGrants` service behind `AUDIENCE_FLOOR_ENABLED`. Absent ⇒ the
   * orchestrator installs no audience provider and the three guards
   * short-circuit, which is the "not enforced ≠ closed" rule they are built on.
   * Passing a store is therefore the switch, and the reason it is a switch
   * rather than a default is that the floor fails closed — an empty grant table
   * bounds every room to nothing.
   */
  readonly audienceGrants?: GrantStore;
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
  /**
   * The resolved orchestrator model after the per-Agent overlay was applied —
   * i.e. the actual id the turn loop will send to the provider for this Agent.
   * Mirrors `config.model`; carried out so callers (registry log, /admin UI)
   * can read it without re-computing the overlay. Issue #296 acceptance #4.
   */
  readonly effectiveModel: string;
  /** Same as `config.modelRouting` — surfaced so callers can describe the
   *  per-turn routing the Agent is on without inspecting the orchestrator. */
  readonly effectiveModelRouting?: ModelRoutingConfig;
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

  // #579 — security screener + audit sink, keyed off the resolved posture.
  // Late-bound thunks (see `OrchestratorOptions`): resolved once per turn, so a
  // screen-URL change on rebuild takes effect without touching this closure.
  // The screener is the external HTTP proxy when the operator set a URL, else
  // the default LLM judge over THIS agent's provider + model (temperature 0).
  const securityScreener = (): SecurityScreener => {
    const url = deps.securityPosture?.screenUrl;
    return url
      ? new HttpProxyScreener({ url })
      : new LlmScreener({ provider: deps.provider, model: config.model });
  };
  // The audit sink is fire-and-forget. `SessionLogger.log` is turn-shaped (it
  // records a user/assistant exchange), so a security event does not fit it;
  // the default sink writes a structured operational log line — the same idiom
  // the codebase uses for the privacy-receipt drop and the override warnings.
  // The injectable `securityAuditSink` option is the extension point for a
  // durable audit store when one lands (there is no central audit bus today).
  const securityAuditSink =
    () =>
    (event: SecurityAuditEvent): void => {
      console.warn(`[security-audit] ${JSON.stringify(event)}`);
    };

  // domainTools is intentionally empty at construct — sub-agents self-register
  // post-activate via `dynamicAgentRuntime.attachOrchestrator(bundle.raw)`.
  const orchestrator = new Orchestrator({
    agentId: config.agentId,
    provider: deps.provider,
    model: config.model,
    ...(config.modelRouting ? { modelRouting: config.modelRouting } : {}),
    ...(config.directLineSticky ? { directLineSticky: true } : {}),
    ...(deps.directLineStickyStore
      ? { directLineStickyStore: deps.directLineStickyStore }
      : {}),
    ...(config.personaSkills?.length
      ? { personaSkills: config.personaSkills }
      : {}),
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
    // W2-1 (#544) — both or neither: a store with no replayer would park calls
    // the user can answer but nothing can deliver.
    ...(deps.pendingMcpInput && deps.mcpInputReplay
      ? {
          pendingMcpInput: deps.pendingMcpInput,
          mcpInputReplay: deps.mcpInputReplay,
        }
      : {}),
    suggestFollowUpsTool,
    ...(findFreeSlotsTool ? { findFreeSlotsTool } : {}),
    ...(bookMeetingTool ? { bookMeetingTool } : {}),
    ...(deps.embeddingClient ? { embeddingClient: deps.embeddingClient } : {}),
    responseGuard: deps.responseGuard,
    privacyGuard: deps.privacyGuard,
    ...(deps.turnReceiptStore
      ? { turnReceiptStore: deps.turnReceiptStore }
      : {}),
    ...(deps.pluginConfigGet
      ? { pluginConfigGet: deps.pluginConfigGet }
      : {}),
    ...(deps.isPluginToolsReady
      ? { isPluginToolsReady: deps.isPluginToolsReady }
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
    ...(deps.aiDisclosure ? { aiDisclosure: deps.aiDisclosure } : {}),
    ...(deps.aiDisclosureSeenStore
      ? { aiDisclosureSeenStore: deps.aiDisclosureSeenStore }
      : {}),
    // #579 — org security posture + its screener/audit sink. Posture absent →
    // orchestrator applies the shipping default (`auto`); the screener + sink
    // are always wired (inert unless screening is enabled for the posture).
    ...(deps.securityPosture ? { securityPosture: deps.securityPosture } : {}),
    // #575 — supplying this is what makes the audience guards non-inert.
    ...(deps.audienceGrants ? { audienceGrants: deps.audienceGrants } : {}),
    securityScreener,
    securityAuditSink,
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
      // Issue #474 — this dispatcher bypasses `Orchestrator.dispatchTool`
      // entirely (the CLI reaches tools over the loopback MCP server), so
      // the readiness gate must be repeated here too.
      ...(deps.isPluginToolsReady
        ? { isPluginToolsReady: deps.isPluginToolsReady }
        : {}),
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
      effectiveModel: config.model,
      ...(config.modelRouting ? { effectiveModelRouting: config.modelRouting } : {}),
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
    effectiveModel: config.model,
    ...(config.modelRouting ? { effectiveModelRouting: config.modelRouting } : {}),
  };
}
