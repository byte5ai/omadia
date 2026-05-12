import Anthropic from '@anthropic-ai/sdk';
import type { ChatAgent } from '@omadia/channel-sdk';
import type { EmbeddingClient } from '@omadia/embeddings';
// Phase 5B: structural shim — `@omadia/integration-microsoft365` lives
// in the byte5-plugins backup repo. The orchestrator types against a
// narrow accessor shape that matches what the plugin publishes under
// `microsoft365.graph`.
import type { Microsoft365Accessor } from './microsoft365-shim.js';
import type {
  EntityRefBus,
  KnowledgeGraph,
  NudgeProvider,
  NudgeStateStore,
  ProcessMemoryService,
  ResponseGuardService,
  SessionBriefingService,
} from '@omadia/plugin-api';
import {
  InMemoryNudgeRegistry,
  NUDGE_PROVIDERS_SERVICE_NAME,
  NUDGE_REGISTRY_SERVICE_NAME,
  NUDGE_STATE_SERVICE_NAME,
  PROCESS_MEMORY_SERVICE_NAME,
} from '@omadia/plugin-api';
import type {
  ContextRetriever,
  FactExtractor,
} from '@omadia/orchestrator-extras';
import type { MemoryStore, PluginContext } from '@omadia/plugin-api';
import {
  PRIVACY_REDACT_SERVICE_NAME,
  RESPONSE_GUARD_SERVICE_NAME,
  type PrivacyGuardService,
} from '@omadia/plugin-api';
import type { VerifierBundle } from '@omadia/verifier';

import { ChatSessionStore } from './chatSessionStore.js';
import type { NativeToolRegistry } from './nativeToolRegistry.js';
import { Orchestrator } from './orchestrator.js';
import { SessionLogger } from './sessionLogger.js';
import { AskUserChoiceTool } from './tools/askUserChoiceTool.js';
import { BookMeetingTool } from './tools/bookMeetingTool.js';
import { ChatParticipantsTool } from './tools/chatParticipantsTool.js';
import { FindFreeSlotsTool } from './tools/findFreeSlotsTool.js';
import { SuggestFollowUpsTool } from './tools/suggestFollowUpsTool.js';
import {
  EDIT_PROCESS_TOOL_NAME,
  PROCESS_MEMORY_SYSTEM_PROMPT_DOC,
  QUERY_PROCESSES_TOOL_NAME,
  RUN_STORED_PROCESS_TOOL_NAME,
  WRITE_PROCESS_TOOL_NAME,
  createEditProcessHandler,
  createQueryProcessesHandler,
  createRunStoredProcessHandler,
  createWriteProcessHandler,
  editProcessToolSpec,
  queryProcessesToolSpec,
  runStoredProcessToolSpec,
  writeProcessToolSpec,
} from './tools/processMemoryTool.js';
import { VerifierService } from './verifierService.js';

/**
 * @omadia/orchestrator — plugin entry point.
 *
 * **S+10-4a: capability lifetime flipped from kernel-bridge to
 * plugin-owned.** activate() reads its setup-fields, late-resolves the
 * service-stack (knowledgeGraph + memoryStore + entityRefBus hard;
 * embeddingClient + contextRetriever + factExtractor + verifier +
 * microsoft365.graph optional), constructs the Anthropic client, the
 * ChatSessionStore + SessionLogger pair, the five kernel-side native
 * tools (chatParticipants / askUserChoice / suggestFollowUps +
 * findFreeSlots/bookMeeting iff microsoft365.graph available), the
 * Orchestrator-Class itself, and an optional VerifierService wrapper
 * (when `verifier@1` is published), and publishes the bundle as
 * `chatAgent@1`:
 *
 *   {
 *     agent:            ChatAgent             // verifier-wrapped or bare
 *     raw:              Orchestrator          // for attachOrchestrator
 *     sessionLogger:    SessionLogger         // shared with graphBackfill + dev-route
 *     chatSessionStore: ChatSessionStore      // shared with /api/chat/sessions
 *   }
 *
 * **NativeToolRegistry**: the kernel still constructs the singleton
 * (because tool-runtime activation populates it BEFORE the orchestrator-
 * plugin activates, plus it's threaded through PluginContext for plugin
 * tool registration). Kernel publishes the instance via
 * `serviceRegistry.provide('nativeToolRegistry', ntr)` before
 * activateAllInstalled, and we late-resolve here.
 *
 * **DomainTools**: constructed empty here. The kernel's
 * `dynamicAgentRuntime.attachOrchestrator(bundle.raw)` call (post-
 * activate) registers each uploaded agent's tool via
 * `Orchestrator.registerDomainTool`. Kernel-built native sub-agents
 * (calendar, accounting, hr, confluence-playbook) similarly use
 * registerDomainTool from their kernel construction sites — no
 * change to the agent-side flow.
 *
 * **Always-Register-Bootstrap-Pattern (S+9.1 Rule #8)**: activate() is
 * tolerant of missing config. Without `anthropic_api_key`, the plugin
 * still activates but does NOT publish `chatAgent@1` — the kernel sees
 * no capability and channel-plugins (after S+10-4b declares
 * `requires: ["chatAgent@^1"]`) skip activation. This keeps the bot
 * boot-able in dev environments without Claude credentials.
 *
 * **S+10-4b** (next sub-commit): Teams + Telegram channel manifests
 * gain `requires: ["chatAgent@^1"]` and their plugin.ts files
 * late-resolve `chatAgent` from `ctx.services.get` instead of taking
 * it as a kernel-passed dep. After 4b the kernel only needs to
 * `attachOrchestrator` the dynamic-agent runtime; channels self-wire.
 */

const CHAT_AGENT_SERVICE = 'chatAgent';
const NATIVE_TOOL_REGISTRY_SERVICE = 'nativeToolRegistry';

const DEFAULT_MODEL = 'claude-sonnet-4-5-20251022';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_ITERATIONS = 12;

/**
 * Public shape of the `chatAgent@1` capability. Channel-plugins (Teams,
 * Telegram, the kernel-side HTTP /api/chat route) consume `agent` for
 * `chat()` / `chatStream()`. The kernel late-resolves `raw` to wire the
 * `dynamicAgentRuntime.attachOrchestrator` call. `sessionLogger` and
 * `chatSessionStore` are exposed because the kernel still owns the
 * graphBackfill (sessionLogger) call and the `/api/chat/sessions` route
 * (chatSessionStore) — both consume the plugin-owned instances rather
 * than holding their own copies.
 */
export interface ChatAgentBundle {
  agent: ChatAgent;
  raw: Orchestrator;
  sessionLogger: SessionLogger;
  chatSessionStore: ChatSessionStore;
}

export interface OrchestratorPluginHandle {
  close(): Promise<void>;
}

function parseNumberOrDefault(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export async function activate(
  ctx: PluginContext,
): Promise<OrchestratorPluginHandle> {
  ctx.log('activating orchestrator plugin');

  // S+12.6: anthropic_api_key is vault-stored (matches database_url-pattern).
  // Bootstrap writes it during installation; operator can override via setup-form
  // post-install. Pre-S+12.6 entries are migrated automatically by
  // bootstrapOrchestratorFromEnv on first boot (config → vault).
  const apiKey = ((await ctx.secrets.get('anthropic_api_key')) ?? '').trim();
  if (!apiKey) {
    ctx.log(
      '[harness-orchestrator] anthropic_api_key not set — chatAgent@1 capability NOT published',
    );
    return {
      async close(): Promise<void> {
        ctx.log('[harness-orchestrator] deactivating (no api key)');
      },
    };
  }

  // Hard-required services (declared in manifest.requires)
  const knowledgeGraph =
    ctx.services.get<KnowledgeGraph>('knowledgeGraph');
  if (!knowledgeGraph) {
    ctx.log(
      '[harness-orchestrator] knowledgeGraph capability missing — chatAgent@1 NOT published',
    );
    return {
      async close(): Promise<void> {
        ctx.log('[harness-orchestrator] deactivating (no knowledgeGraph)');
      },
    };
  }
  const memoryStore = ctx.services.get<MemoryStore>('memoryStore');
  if (!memoryStore) {
    ctx.log(
      '[harness-orchestrator] memoryStore capability missing — chatAgent@1 NOT published',
    );
    return {
      async close(): Promise<void> {
        ctx.log('[harness-orchestrator] deactivating (no memoryStore)');
      },
    };
  }
  const entityRefBus = ctx.services.get<EntityRefBus>('entityRefBus');
  if (!entityRefBus) {
    ctx.log(
      '[harness-orchestrator] entityRefBus capability missing — chatAgent@1 NOT published',
    );
    return {
      async close(): Promise<void> {
        ctx.log('[harness-orchestrator] deactivating (no entityRefBus)');
      },
    };
  }

  // Kernel-shared NativeToolRegistry (kernel publishes pre-activate)
  const nativeToolRegistry = ctx.services.get<NativeToolRegistry>(
    NATIVE_TOOL_REGISTRY_SERVICE,
  );
  if (!nativeToolRegistry) {
    ctx.log(
      '[harness-orchestrator] nativeToolRegistry not provided by kernel — chatAgent@1 NOT published',
    );
    return {
      async close(): Promise<void> {
        ctx.log(
          '[harness-orchestrator] deactivating (no nativeToolRegistry)',
        );
      },
    };
  }

  // OB-76 (Palaia Phase 7) — Process-Memory. Optional capability:
  // when the KG provider has no processes table (in-memory, no
  // database_url), the service is absent and the 4 tools are NOT
  // registered (no spec in the LLM tool list, no doc in the system prompt).
  // Live in the standard prod setup (Neon-KG + embedding sidecar).
  const processMemory = ctx.services.get<ProcessMemoryService>(
    PROCESS_MEMORY_SERVICE_NAME,
  );

  // Optional services — graceful degrade when absent
  const embeddingClient =
    ctx.services.get<EmbeddingClient>('embeddingClient');
  const contextRetriever =
    ctx.services.get<ContextRetriever>('contextRetriever');
  const factExtractor = ctx.services.get<FactExtractor>('factExtractor');
  // OB-75 (Palaia Phase 6) — optional. Published by harness-orchestrator-extras
  // when an Anthropic key is configured. Absent → orchestrator skips the
  // briefing prepend, behaviour identical to pre-OB-75.
  const sessionBriefing =
    ctx.services.get<SessionBriefingService>('sessionBriefing');
  const verifierBundle = ctx.services.get<VerifierBundle>('verifier');
  const microsoft365 = ctx.services.get<Microsoft365Accessor>(
    'microsoft365.graph',
  );
  // Phase-1 of the Kemia integration. Late-bound `responseGuard@1` getter —
  // the orchestrator generally activates BEFORE its tool plugins, so a
  // bind-at-activate lookup would always miss the responseGuard provider
  // installed alongside it. Wrapping the lookup in a thunk lets the
  // orchestrator re-resolve once per turn; install/uninstall takes effect
  // on the next turn without a host restart. Absent provider → empty
  // rules block + identical pre-plugin behaviour.
  const responseGuardGetter = (): ResponseGuardService | undefined =>
    ctx.services.get<ResponseGuardService>(RESPONSE_GUARD_SERVICE_NAME);

  // Privacy-Proxy Slice 2.1. Same late-bound pattern: install/uninstall
  // of the privacy-guard plugin takes effect on the next turn without a
  // host restart. Absent provider → byte-identical pre-plugin behaviour
  // (no tokenisation, no receipt).
  const privacyGuardGetter = (): PrivacyGuardService | undefined =>
    ctx.services.get<PrivacyGuardService>(PRIVACY_REDACT_SERVICE_NAME);

  // Setup-field config (with defaults)
  const model =
    (ctx.config.get<string>('orchestrator_model') ?? '').trim() ||
    DEFAULT_MODEL;
  const maxTokens = parseNumberOrDefault(
    ctx.config.get<unknown>('orchestrator_max_tokens'),
    DEFAULT_MAX_TOKENS,
  );
  const maxIterations = parseNumberOrDefault(
    ctx.config.get<unknown>('max_tool_iterations'),
    DEFAULT_MAX_ITERATIONS,
  );

  // Anthropic client + storage layer
  const client = new Anthropic({ apiKey });
  const chatSessionStore = new ChatSessionStore(memoryStore);
  const sessionLogger = new SessionLogger(
    memoryStore,
    knowledgeGraph,
    chatSessionStore,
  );

  // Native-tool instances (channel-coupled UI cards + calendar)
  const chatParticipantsTool = new ChatParticipantsTool();
  const askUserChoiceTool = new AskUserChoiceTool();
  const suggestFollowUpsTool = new SuggestFollowUpsTool();
  const findFreeSlotsTool = microsoft365
    ? new FindFreeSlotsTool(
        microsoft365.obo,
        microsoft365.calendar,
        microsoft365.slots,
      )
    : undefined;
  const bookMeetingTool = microsoft365
    ? new BookMeetingTool(
        microsoft365.obo,
        microsoft365.calendar,
        microsoft365.slots,
      )
    : undefined;

  // OB-77 (Palaia Phase 8) — Nudge-Pipeline. Publish a fresh in-memory
  // registry, then drain `nudgeProviders@1` (side-channel for plugins
  // that activate BEFORE the orchestrator and can't reach the registry
  // directly). Late-resolve `nudgeStateStore@1` so we tolerate KG-Provider
  // boots without a durable schema (in-memory KG → no store → no-op).
  const nudgeRegistry = new InMemoryNudgeRegistry();
  const disposeNudgeRegistry = ctx.services.provide(
    NUDGE_REGISTRY_SERVICE_NAME,
    nudgeRegistry,
  );
  const queuedNudgeProviders =
    ctx.services.get<readonly NudgeProvider[]>(NUDGE_PROVIDERS_SERVICE_NAME) ??
    [];
  for (const provider of queuedNudgeProviders) {
    try {
      nudgeRegistry.register(provider);
    } catch (err) {
      ctx.log(
        `[harness-orchestrator] failed to register queued nudge provider "${provider.id}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const nudgeStateStore = ctx.services.get<NudgeStateStore>(
    NUDGE_STATE_SERVICE_NAME,
  );
  ctx.log(
    `[harness-orchestrator] nudgeRegistry@1 published (stateStore=${nudgeStateStore ? 'on' : 'off'}, queuedProviders=${String(queuedNudgeProviders.length)})`,
  );

  // Orchestrator construction. domainTools is intentionally empty here —
  // sub-agents (kernel-built calendar/accounting/hr/confluence + uploaded
  // agents from dynamicAgentRuntime) self-register via the kernel's
  // `dynamicAgentRuntime.attachOrchestrator(bundle.raw)` post-activate
  // callout, mirroring today's hot-register flow.
  const orchestrator = new Orchestrator({
    client,
    model,
    maxTokens,
    maxToolIterations: maxIterations,
    domainTools: [],
    nativeToolRegistry,
    sessionLogger,
    entityRefBus,
    knowledgeGraph,
    ...(contextRetriever ? { contextRetriever } : {}),
    ...(sessionBriefing ? { sessionBriefing } : {}),
    ...(factExtractor ? { factExtractor } : {}),
    chatParticipantsTool,
    askUserChoiceTool,
    suggestFollowUpsTool,
    ...(findFreeSlotsTool ? { findFreeSlotsTool } : {}),
    ...(bookMeetingTool ? { bookMeetingTool } : {}),
    ...(embeddingClient ? { embeddingClient } : {}),
    responseGuard: responseGuardGetter,
    privacyGuard: privacyGuardGetter,
    nudgeRegistry,
    ...(nudgeStateStore ? { nudgeStateStore } : {}),
    ...(processMemory ? { nudgeProcessMemory: processMemory } : {}),
  });

  // OB-76: attach 4 ProcessMemory native tools via the nativeToolRegistry.
  // Full registration (handler + spec + promptDoc) — the
  // Orchestrator dispatcher routes automatically via
  // `this.nativeTools.get(name).handler` and the getTools() call picks
  // the spec live into the LLM-tool list. No orchestrator code touch.
  const disposeProcessMemoryTools: Array<() => void> = [];
  if (processMemory) {
    disposeProcessMemoryTools.push(
      nativeToolRegistry.register(WRITE_PROCESS_TOOL_NAME, {
        handler: createWriteProcessHandler(processMemory),
        spec: writeProcessToolSpec,
        promptDoc: PROCESS_MEMORY_SYSTEM_PROMPT_DOC,
      }),
    );
    disposeProcessMemoryTools.push(
      nativeToolRegistry.register(EDIT_PROCESS_TOOL_NAME, {
        handler: createEditProcessHandler(processMemory),
        spec: editProcessToolSpec,
      }),
    );
    disposeProcessMemoryTools.push(
      nativeToolRegistry.register(QUERY_PROCESSES_TOOL_NAME, {
        handler: createQueryProcessesHandler(processMemory),
        spec: queryProcessesToolSpec,
      }),
    );
    disposeProcessMemoryTools.push(
      nativeToolRegistry.register(RUN_STORED_PROCESS_TOOL_NAME, {
        handler: createRunStoredProcessHandler(processMemory),
        spec: runStoredProcessToolSpec,
      }),
    );
    ctx.log(
      '[harness-orchestrator] processMemory@1 found — registered 4 native tools (write_process, edit_process, query_processes, run_stored_process)',
    );
  } else {
    ctx.log(
      '[harness-orchestrator] processMemory@1 not available — skipping 4 ProcessMemory tools',
    );
  }

  // Verifier wrapper — only when the verifier@1 capability is published.
  // Without it, the bare Orchestrator IS the chatAgent (it implements the
  // duck-typed ChatAgent contract via chat() + chatStream()).
  let agent: ChatAgent = orchestrator;
  if (verifierBundle) {
    agent = new VerifierService({
      orchestrator,
      pipeline: verifierBundle.pipeline,
      ...(verifierBundle.store ? { store: verifierBundle.store } : {}),
      enabled: true,
      mode: verifierBundle.mode,
      maxRetries: verifierBundle.maxRetries,
    });
    ctx.log(
      `[harness-orchestrator] verifier wrapper enabled (mode=${verifierBundle.mode}, store=${verifierBundle.store ? 'on' : 'off'}, maxRetries=${String(verifierBundle.maxRetries)})`,
    );
  }

  const bundle: ChatAgentBundle = {
    agent,
    raw: orchestrator,
    sessionLogger,
    chatSessionStore,
  };
  ctx.services.provide(CHAT_AGENT_SERVICE, bundle);

  ctx.log(
    `[harness-orchestrator] chatAgent@1 published (model=${model}, maxTokens=${String(maxTokens)}, maxIter=${String(maxIterations)}, verifier=${verifierBundle ? 'on' : 'off'}, calendar=${microsoft365 ? 'on' : 'off'}, contextRetriever=${contextRetriever ? 'on' : 'off'}, factExtractor=${factExtractor ? 'on' : 'off'}, embeddingClient=${embeddingClient ? 'on' : 'off'}, responseGuard=late-bound)`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('[harness-orchestrator] deactivating');
      try {
        disposeNudgeRegistry();
      } catch {
        // best-effort
      }
      for (const dispose of disposeProcessMemoryTools) {
        try {
          dispose();
        } catch {
          // best-effort
        }
      }
    },
  };
}
