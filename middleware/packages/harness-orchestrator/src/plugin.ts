import {
  InMemoryDisclosureSeenStore,
  POSTURE_ORDER,
  type ChatAgent,
  type AiDisclosureLevel,
  type GrantStore,
  type SecurityPosture,
} from '@omadia/channel-sdk';
import type {
  SecurityPostureSetup,
  SecurityScreenMode,
} from './securityScreener.js';
import type { EmbeddingClient } from '@omadia/embeddings';
import {
  resolveLlmProvider,
  type LlmProviderCatalog,
} from '@omadia/llm-provider';
// Phase 5B: structural shim — `@omadia/integration-microsoft365` lives
// in the byte5-plugins backup repo. The orchestrator types against a
// narrow accessor shape that matches what the plugin publishes under
// `microsoft365.graph`.
import type { Microsoft365Accessor } from './microsoft365-shim.js';
import {
  AI_DISCLOSURE_CHANNEL_KINDS as AI_DISCLOSURE_CHANNEL_KIND_LIST,
  AI_DISCLOSURE_POSTURE_SERVICE,
  describeAiDisclosurePosture,
  formatDisclosureBootWarning,
} from './aiDisclosurePosture.js';
import type {
  EntityRefBus,
  KnowledgeGraph,
  NudgeProvider,
  NudgeStateStore,
  PalaiaExcerptExtractor,
  ProcessMemoryService,
  ResponseGuardService,
  SessionBriefingService,
} from '@omadia/plugin-api';
import {
  InMemoryNudgeRegistry,
  NUDGE_PROVIDERS_SERVICE_NAME,
  NUDGE_REGISTRY_SERVICE_NAME,
  NUDGE_STATE_SERVICE_NAME,
  PALAIA_EXCERPT_SERVICE_NAME,
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
  TURN_RECEIPT_STORE_SERVICE_NAME,
  type PrivacyGuardService,
  type TurnReceiptStore,
} from '@omadia/plugin-api';
import type { VerifierBundle } from '@omadia/verifier';

import type { Pool } from 'pg';
import { initUsageRecorder } from '@omadia/usage-telemetry';

import {
  buildOrchestratorForAgent,
  type OrchestratorDeps,
} from './buildOrchestrator.js';
import {
  audienceGuardedAttachmentReader,
  createAttachmentReader,
  type AttachmentByteStore,
} from './attachmentReaderFactory.js';
import type { AttachmentBindingStore } from './attachmentBinding.js';
import type { TurnHookRunner } from './turnHooks.js';
import type { ChatSessionStore } from './chatSessionStore.js';
import type { NativeToolRegistry } from './nativeToolRegistry.js';
import type { Orchestrator, AiDisclosureSetup } from './orchestrator.js';
import { InMemoryDirectLineStickyStore } from './directLineSticky.js';
import {
  sharedMcpInputReplayer,
  sharedPendingMcpInputStore,
} from './mcp/pendingMcpInput.js';
import { DEFAULT_ORCHESTRATOR_MODEL } from './registry/agentRuntime.js';
import { ConfigStore } from './registry/configStore.js';
import {
  OrchestratorRegistry,
  type PluginCapabilityLookup,
} from './registry/index.js';
import { runMultiOrchestratorMigrations } from './registry/migrator.js';
import { ensureFallbackAgent } from './registry/onboarding.js';
import { ReloadBus } from './registry/reloadBus.js';
import { ChannelResolver } from './routing/channelResolver.js';
import type { SessionLogger } from './sessionLogger.js';
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
import {
  EXECUTE_SYSTEM_PROMPT_DOC,
  EXECUTE_TOOL_NAME,
  createExecuteHandler,
  executeToolSpec,
} from './tools/executeTool.js';
import { DockerSandboxBackend } from '@omadia/sandbox';
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
const ORCHESTRATOR_REGISTRY_SERVICE = 'orchestratorRegistry';
const CHANNEL_RESOLVER_SERVICE = 'channelResolver';
const CONFIG_STORE_SERVICE = 'configStore';
const GRAPH_POOL_SERVICE = 'graphPool';
const PLUGIN_CAPABILITIES_SERVICE = 'pluginCapabilities';

// Fallback when the operator has not set `orchestrator_model` in the install
// config. Shared with the registry's per-instance resolution (tier 3) so the
// install-config default and the per-Agent overlay fall back to the same id.
// Kept in sync with the kernel default `ORCHESTRATOR_MODEL` in
// middleware/src/config.ts.
const DEFAULT_MODEL = DEFAULT_ORCHESTRATOR_MODEL;
// 8192, not 4096: a verbose preamble + a large structured tool call (e.g. a
// multi-sheet create_xlsx with formulas) truncates at 4096 → `max_tokens`
// mid-tool-call, so the file is never built. Also enforced as a floor below so
// an already-installed registry config of 4096 gets bumped without reinstall.
const DEFAULT_MAX_TOKENS = 8192;
// Raised 25 → 100 so genuinely multi-step turns (e.g. a price-list comparison
// across many lookups) reach a final answer. The high cap is made safe by the
// orchestrator's round-loop guard (nudges then force-finalises a repeating
// tool batch ~iteration 5) and the best-effort finalize on exhaustion — so a
// runaway loop no longer burns the full budget, and the user never sees the
// raw "exceeded maxToolIterations" error. Also a floor (see below).
const DEFAULT_MAX_ITERATIONS = 100;
// Optional per-turn wall-clock budget, seconds. 0 = disabled (the default —
// the iteration cap + loop guard are the bounds; we do NOT truncate honest
// long turns by default). Operators can opt in via `max_turn_seconds`.
const DEFAULT_MAX_TURN_SECONDS = 0;

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

/** AI-Act Art. 50 (#644) — the tokens the per-channel override map may key on:
 *  the full `ChannelKind` set from `@omadia/plugin-api`. An override for any
 *  other token is dropped with a warning so a typo never silently disables the
 *  marking. NOTE: today only `teams`/`slack`/`telegram` are ever produced as a
 *  per-turn `channelKind` (`orchestratorDispatcher.toChannelKind`); `email` and
 *  `web` are accepted here but currently resolve to the global level, same as
 *  the kind-less channels — see the `ai_disclosure_level_overrides` help text.
 *
 *  #648 — derived from the shared list rather than spelled again here. The
 *  posture view reports one row per accepted kind, so a second literal would
 *  let the parser accept a channel the dashboard never shows (or vice versa). */
const AI_DISCLOSURE_CHANNEL_KINDS = new Set<string>(
  AI_DISCLOSURE_CHANNEL_KIND_LIST,
);

const AI_DISCLOSURE_LEVELS = new Set<AiDisclosureLevel>([
  'standard',
  'concise',
  'off',
]);

function parseAiDisclosureLevel(raw: unknown): AiDisclosureLevel | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  return AI_DISCLOSURE_LEVELS.has(v as AiDisclosureLevel)
    ? (v as AiDisclosureLevel)
    : undefined;
}

/**
 * Parse the compact per-channel override field `"telegram=concise,web=off"`
 * into a `{ channelKind: level }` map. Whitespace-tolerant; unknown channel
 * tokens and unknown levels are dropped with a warning (a silent drop would
 * read as "marking configured" when it is not). Returns `undefined` when
 * nothing valid parsed, so the caller can treat it as "no overrides".
 */
function parseAiDisclosureOverrides(
  raw: unknown,
): Record<string, AiDisclosureLevel> | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  const out: Record<string, AiDisclosureLevel> = {};
  for (const pair of raw.split(',')) {
    // Empty segments (trailing or doubled commas) are formatting, not a typo —
    // skip them silently. Anything else missing its `=` falls through to the
    // warn branch below: dropping `"telegram"` without a word would read as
    // "override configured" when none was, the exact failure this warns about.
    if (pair.trim().length === 0) continue;
    const eq = pair.indexOf('=');
    const chan = eq < 0 ? '' : pair.slice(0, eq).trim().toLowerCase();
    const level = eq < 0 ? undefined : parseAiDisclosureLevel(pair.slice(eq + 1));
    if (!AI_DISCLOSURE_CHANNEL_KINDS.has(chan) || level === undefined) {
      console.warn(
        `[orchestrator] ai_disclosure_level_overrides: ignoring invalid entry "${pair.trim()}" ` +
          `(channel must be one of ${[...AI_DISCLOSURE_CHANNEL_KINDS].join('/')}, ` +
          `level one of standard/concise/off)`,
      );
      continue;
    }
    out[chan] = level;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Resolve the operator's AI-disclosure setup (#644) from the plugin config.
 * Returns `undefined` when the operator set NO disclosure field at all — the
 * signal the orchestrator reads as "shipping default (standard, active) on
 * every channel, `source: 'default'`" (AC1). As soon as ANY field is set the
 * whole config is operator-sourced, so an `'off'` level is honoured (a turn
 * cannot silence itself; only the operator can).
 */
function resolveAiDisclosureSetup(
  read: (key: string) => unknown,
): AiDisclosureSetup | undefined {
  const level = parseAiDisclosureLevel(read('ai_disclosure_level'));
  const overrides = parseAiDisclosureOverrides(
    read('ai_disclosure_level_overrides'),
  );
  const localeRaw = read('ai_disclosure_locale');
  const locale =
    typeof localeRaw === 'string' && localeRaw.trim().length > 0
      ? localeRaw.trim()
      : undefined;
  const nameRaw = read('ai_disclosure_assistant_name');
  const assistantName =
    typeof nameRaw === 'string' && nameRaw.trim().length > 0
      ? nameRaw.trim()
      : undefined;
  const noteRaw = read('ai_disclosure_operator_note');
  const operatorNote =
    typeof noteRaw === 'string' && noteRaw.trim().length > 0
      ? noteRaw.trim()
      : undefined;

  if (
    level === undefined &&
    overrides === undefined &&
    locale === undefined &&
    assistantName === undefined &&
    operatorNote === undefined
  ) {
    return undefined;
  }
  return {
    // Level unset but other fields present → keep the shipping-default level;
    // `source: 'operator'` (implied by a non-undefined setup) still lets an
    // explicit `'off'` through when the operator DID set it.
    level: level ?? 'standard',
    ...(overrides ? { overrides } : {}),
    ...(locale ? { locale } : {}),
    ...(assistantName ? { assistantName } : {}),
    ...(operatorNote ? { operatorNote } : {}),
  };
}

/** #579 — parse a security-posture enum value. Returns undefined for unset /
 *  unknown so the caller can fall back to the shipping floor. */
function parseSecurityPosture(raw: unknown): SecurityPosture | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  return (POSTURE_ORDER as readonly string[]).includes(v)
    ? (v as SecurityPosture)
    : undefined;
}

/** #579 — parse the screen mode. Default (unset/unknown) → `enforce`, the safe
 *  direction: an operator opts INTO shadow, never falls into it by a typo. */
function parseSecurityScreenMode(raw: unknown): SecurityScreenMode {
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'shadow') {
    return 'shadow';
  }
  return 'enforce';
}

/**
 * #579 — resolve the operator's security-posture setup from plugin config, the
 * same arrival pattern as {@link resolveAiDisclosureSetup}. Returns `undefined`
 * when the operator set NO security field at all — the signal the orchestrator
 * reads as "shipping default (`auto`, enforce)". `security_posture` is the org
 * FLOOR; `security_posture_override` may only TIGHTEN it (a looser value is
 * warned and dropped, so it clamps to the floor at resolution — never a silent
 * loosening). `security_screen_url` selects the external HTTP proxy;
 * `security_screen_mode` is shadow/enforce.
 *
 * NAMING (#575): this field was `security_posture_scope`. It is a single
 * deployment-wide posture VALUE with no identity, not a per-scope setting —
 * and since #713 landed `ScopeId`, "scope" in this tree means an identified
 * partition (`personal:` / `conversation:` / `group:` / `org:` / `system:`).
 * Keeping the old name would have read as "the posture for a given scope",
 * which is exactly what it is not. When the real per-scope posture arrives it
 * folds `tightenPosture` over a scope's ancestor chain; this override stays the
 * deployment-level knob.
 */
function resolveSecurityPostureSetup(
  read: (key: string) => unknown,
): SecurityPostureSetup | undefined {
  const floor = parseSecurityPosture(read('security_posture'));
  const overrideRaw = read('security_posture_override');
  let override = parseSecurityPosture(overrideRaw);
  const modeRaw = read('security_screen_mode');
  const urlRaw = read('security_screen_url');
  const screenUrl =
    typeof urlRaw === 'string' && urlRaw.trim().length > 0
      ? urlRaw.trim()
      : undefined;

  const anySet =
    floor !== undefined ||
    override !== undefined ||
    screenUrl !== undefined ||
    (typeof modeRaw === 'string' && modeRaw.trim().length > 0);
  if (!anySet) return undefined;

  const effectiveFloor = floor ?? 'auto';
  // A scope that tries to LOOSEN below the floor is refused here with a warning
  // (a silent drop would read as "floor honoured" when it was overridden). The
  // tighten-only math is enforced again at runtime in `resolveEffectivePosture`;
  // dropping it here keeps the setup itself honest.
  if (
    override !== undefined &&
    POSTURE_ORDER.indexOf(override) < POSTURE_ORDER.indexOf(effectiveFloor)
  ) {
    console.warn(
      `[orchestrator] security_posture_override="${String(overrideRaw)}" is looser than ` +
        `the org floor "${effectiveFloor}" — refused (scopes may only tighten). ` +
        `Falling back to the floor.`,
    );
    override = undefined;
  }

  return {
    floor: effectiveFloor,
    ...(override !== undefined ? { override } : {}),
    mode: parseSecurityScreenMode(modeRaw),
    ...(screenUrl ? { screenUrl } : {}),
  };
}

/** Truthy values: '1', 'true', 'yes', 'on' (case-insensitive). Everything
 *  else is false — including undefined/empty. */
function parseBooleanEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export async function activate(
  ctx: PluginContext,
): Promise<OrchestratorPluginHandle> {
  ctx.log('activating orchestrator plugin');

  // Build the configured LLM provider (default Anthropic) from the vault —
  // shared across every Agent built from this plugin. The factory reads the
  // provider-namespaced key (with the legacy fallback for Anthropic); undefined
  // means no key is configured for the chosen provider.
  //
  // maxRetries: 5 — the SDK auto-retries 408/409/429/500/529 with exponential
  // backoff (default 2); bumped to 5 so a transient overloaded_error (HTTP 529)
  // burst is far more likely to ride out inside the SDK than fail a turn.
  const providerId =
    (ctx.config.get<string>('llm_provider') ?? '').trim() || 'anthropic';
  // Plugin-contributed providers (e.g. MiniMax) supply their baseURL + quirks
  // via the kernel's LlmProviderCatalog; passing it lets the factory resolve a
  // provider id that isn't built in. Absent for the Anthropic/OpenAI defaults.
  const llmProviderCatalog = ctx.services.get<LlmProviderCatalog>(
    'llmProviderCatalog',
  );
  const provider = await resolveLlmProvider({
    providerId,
    getSecret: (k) => ctx.secrets.get(k),
    maxRetries: 5,
    ...(llmProviderCatalog !== undefined
      ? { catalog: llmProviderCatalog }
      : {}),
  });
  if (!provider) {
    ctx.log(
      `[harness-orchestrator] no API key for provider '${providerId}' — chatAgent@1 capability NOT published`,
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
  // #133 E0 — kernel-owned turn-hook runner (optional; graceful degrade).
  const turnHookRegistry =
    ctx.services.get<TurnHookRunner>('turnHookRegistry');
  // KG-ACL Slice 4a — Palaia-Excerpt-Extractor. Published by
  // harness-orchestrator-extras when an Anthropic key is configured.
  // Absent → orchestrator's `done` event ships without `palaiaExcerpt`
  // and the chat-side save-as-memory modal falls back to its dumb
  // 240-char prefix.
  const excerptExtractor = ctx.services.get<PalaiaExcerptExtractor>(
    PALAIA_EXCERPT_SERVICE_NAME,
  );
  // OB-75 (Palaia Phase 6) — optional. Published by harness-orchestrator-extras
  // when an Anthropic key is configured. Absent → orchestrator skips the
  // briefing prepend, behaviour identical to pre-OB-75.
  const sessionBriefing =
    ctx.services.get<SessionBriefingService>('sessionBriefing');
  const verifierBundle = ctx.services.get<VerifierBundle>('verifier');
  const microsoft365 = ctx.services.get<Microsoft365Accessor>(
    'microsoft365.graph',
  );
  // #268 — attachment byte source. The kernel provides `tigrisStore` (the same
  // S3/Tigris bucket Teams uploads + brand:// logos use) when the bucket env
  // is configured. Absent → the reader's storage-key path is inert; URL reads
  // still work via fetch. The reader drives auto-ingest + the read_attachment
  // tool; harness-orchestrator stays free of any @aws-sdk dependency.
  const attachmentByteStore =
    ctx.services.get<AttachmentByteStore>('tigrisStore');
  // #575 — every attachment-handle redemption passes the audience floor. Wrapped
  // here, at the ONE construction site, so the check rides with the handle rather
  // than depending on each resolution site remembering to ask. Inert unless an
  // audience source is installed.
  // The binding store additionally pins each handle to the room that minted it
  // (#575). Published by the kernel only when the audience floor is enabled —
  // absent means that second check stands down, and the reader behaves exactly
  // as it did before.
  const attachmentBindings = ctx.services.get<AttachmentBindingStore>('attachmentBindings');
  const attachmentReader = audienceGuardedAttachmentReader(
    createAttachmentReader(attachmentByteStore),
    attachmentBindings,
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

  // #757 — persistent per-turn receipt store, published by the kernel once
  // its pg pool resolves (in-memory backend: never provided, receipts stay
  // ephemeral). Same late-bound shape as the two getters above.
  const turnReceiptStoreGetter = (): TurnReceiptStore | undefined =>
    ctx.services.get<TurnReceiptStore>(TURN_RECEIPT_STORE_SERVICE_NAME);

  // Slice 2.5 — cross-plugin runtime-config reader for the privacy
  // bypass resolver. Published by the kernel at boot
  // (`middleware/src/index.ts:installedPluginConfigReader`). When absent
  // (legacy hosts, unit tests) the resolver falls back to kernel-tool
  // bypass only — domain and sub-agent inner tools then always run
  // guarded.
  const pluginConfigGet = ctx.services.get<
    (agentId: string, configKey: string) => unknown | undefined
  >('installedPluginConfigReader');

  // Issue #474 — per-plugin tool-readiness gate. Published by the kernel at
  // boot (`middleware/src/index.ts:installedPluginToolsReadyReader`), backed
  // by `PluginStatusRegistry`. Absent (legacy hosts, unit tests) → every
  // plugin's tools stay available exactly as before #474.
  const isPluginToolsReady = ctx.services.get<
    (agentId: string) => boolean
  >('installedPluginToolsReadyReader');

  // Setup-field config (with defaults)
  const model =
    (ctx.config.get<string>('orchestrator_model') ?? '').trim() ||
    DEFAULT_MODEL;
  // Operator persona. Empty → Orchestrator falls back to its generic,
  // integration-agnostic `DEFAULT_ASSISTANT_IDENTITY`. Lets a deployment
  // brand the bot without a hardcoded "byte5 / Odoo" identity in the harness.
  const assistantIdentity = (
    ctx.config.get<string>('assistant_identity') ?? ''
  ).trim();
  // AI-Act Art. 50 (#644) — resolve the operator's disclosure setup once at
  // build time (same arrival pattern as `assistantIdentity`). Undefined → the
  // orchestrator applies the shipping default (standard, active) on every
  // channel; a set value flips the whole policy to operator-sourced.
  const aiDisclosure = resolveAiDisclosureSetup((key) =>
    ctx.config.get<unknown>(key),
  );
  // #579 — resolve the operator's security posture once at build time. Undefined
  // → the orchestrator applies the shipping default (`auto`, enforce). The
  // screener + audit sink are wired in `buildOrchestrator` (they need the
  // provider + session logger); only the posture setup is config-derived here.
  const securityPosture = resolveSecurityPostureSetup((key) =>
    ctx.config.get<unknown>(key),
  );
  // #575 — the audience floor's capability grants. Published by the kernel
  // BEFORE plugin activation (as a late-bound wrapper, because the Postgres
  // pool it needs is published by the knowledge-graph plugin during this same
  // pass) and ONLY when `AUDIENCE_FLOOR_ENABLED` is set. Undefined is the
  // ordinary case: the orchestrator then installs no audience provider at all
  // and every guard short-circuits, leaving behaviour unchanged.
  const audienceGrants = ctx.services.get<GrantStore>('audienceGrants');
  // #648 — publish the RESOLVED posture so `/health` and the operator
  // dashboard can read what this instance actually does, and warn once at boot
  // when it deviates from the delivered state. A reduced marking is a
  // legitimate operator decision; the failure mode #648 is about is that it was
  // previously invisible, so a copy-paste error in a config or a leftover from
  // a test setup was never noticed by anyone.
  //
  // A plain frozen snapshot, unlike the embedding gate's live getter object:
  // this posture is derived from setup fields read once at activation, and a
  // config change re-activates the plugin, which re-publishes. Nothing mutates
  // it underneath a reader.
  const disclosurePosture = describeAiDisclosurePosture(aiDisclosure);
  const disclosureWarning = formatDisclosureBootWarning(disclosurePosture);
  if (disclosureWarning) console.warn(disclosureWarning);
  const disposeDisclosurePosture = ctx.services.provide(
    AI_DISCLOSURE_POSTURE_SERVICE,
    disclosurePosture,
  );
  // Floor at DEFAULT_MAX_TOKENS: a stale installed config (older deployments
  // persisted 4096) would otherwise truncate large file-building tool calls.
  const maxTokens = Math.max(
    parseNumberOrDefault(
      ctx.config.get<unknown>('orchestrator_max_tokens'),
      DEFAULT_MAX_TOKENS,
    ),
    DEFAULT_MAX_TOKENS,
  );
  // Floor at DEFAULT_MAX_ITERATIONS: a stale installed config (older
  // deployments persisted 12) would otherwise abort multi-step tasks early
  // with "exceeded maxToolIterations" before reaching a final answer.
  const maxIterations = Math.max(
    parseNumberOrDefault(
      ctx.config.get<unknown>('max_tool_iterations'),
      DEFAULT_MAX_ITERATIONS,
    ),
    DEFAULT_MAX_ITERATIONS,
  );
  // Optional per-turn wall-clock budget (seconds). Default 0 = off; a stale
  // config is not floored (operators may legitimately want no budget).
  const maxTurnSeconds = parseNumberOrDefault(
    ctx.config.get<unknown>('max_turn_seconds'),
    DEFAULT_MAX_TURN_SECONDS,
  );
  // Round-loop guard thresholds (omit → LoopGuard defaults 3 / 5). `0` or an
  // unparseable value falls back to the default rather than disabling the guard.
  const loopRepeatSoft = parseNumberOrDefault(
    ctx.config.get<unknown>('loop_repeat_soft'),
    0,
  );
  const loopRepeatHard = parseNumberOrDefault(
    ctx.config.get<unknown>('loop_repeat_hard'),
    0,
  );

  // KG-ACL Slice 4b — env-var opt-in for auto-promotion at
  // significance ≥ threshold. Read straight from process.env (these
  // are operator-level feature flags, not per-plugin setup fields).
  // Default ON — significant turns auto-promote to the Knowledge-Graph
  // out of the box. Still gated at runtime by the capture-filter scorer
  // (needs `capture_level >= normal`, now the default) and the presence of
  // a Postgres KG + Anthropic key; without those the promote is a no-op.
  // Set `KG_ACL_AUTO_PROMOTE=false` to opt out. NOTE: this means a Haiku
  // significance call per captured turn — real Anthropic spend + latency.
  const autoPromote =
    process.env['KG_ACL_AUTO_PROMOTE'] === undefined
      ? true
      : parseBooleanEnv(process.env['KG_ACL_AUTO_PROMOTE']);
  const autoPromoteThreshold = parseNumberOrDefault(
    process.env['KG_ACL_AUTO_PROMOTE_THRESHOLD'],
    0.7,
  );
  // Trigger T3 — durable auto-promotion: high-significance reference MK is
  // marked manuallyAuthored (always-surface durable tier). Default ON at 0.85;
  // set KG_DURABLE_AUTOPROMOTE=false to disable. Kinds default to ['reference']
  // inside promoteTurnIfSignificant.
  const durableAutoPromoteEnabled =
    process.env['KG_DURABLE_AUTOPROMOTE'] === undefined
      ? true
      : parseBooleanEnv(process.env['KG_DURABLE_AUTOPROMOTE']);
  const autoPromoteDurableMinSignificance = durableAutoPromoteEnabled
    ? parseNumberOrDefault(
        process.env['KG_DURABLE_AUTOPROMOTE_MIN_SIGNIFICANCE'],
        0.85,
      )
    : undefined;
  const graphPool = ctx.services.get<Pool>(GRAPH_POOL_SERVICE);
  const graphTenantId =
    process.env['GRAPH_TENANT_ID'] ??
    ctx.config.get<string>('graph_tenant_id') ??
    'default';

  // Cost telemetry: wire the usage recorder to the shared graph pool. The
  // orchestrator + sub-agent usage is captured inside streamMessageEvents;
  // this just ensures the recorder has a pool to flush to. Idempotent.
  if (graphPool) initUsageRecorder(graphPool);

  // (LLM provider built above from the configured provider id.)

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
  for (const nudgeProvider of queuedNudgeProviders) {
    try {
      nudgeRegistry.register(nudgeProvider);
    } catch (err) {
      ctx.log(
        `[harness-orchestrator] failed to register queued nudge provider "${nudgeProvider.id}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const nudgeStateStore = ctx.services.get<NudgeStateStore>(
    NUDGE_STATE_SERVICE_NAME,
  );
  ctx.log(
    `[harness-orchestrator] nudgeRegistry@1 published (stateStore=${nudgeStateStore ? 'on' : 'off'}, queuedProviders=${String(queuedNudgeProviders.length)})`,
  );

  // US3 — Orchestrator construction is the per-Agent factory
  // `buildOrchestratorForAgent`; invoked below, after the process-wide
  // ProcessMemory tool registration. main's main-line `new Orchestrator()`
  // call was replaced by the factory in US3; its new fields (autoPromote /
  // autoPromoteThreshold / graphPool / graphTenantId / excerptExtractor /
  // assistantIdentity) flow through via `OrchestratorDeps`.

  // OB-76: attach 4 ProcessMemory native tools via the nativeToolRegistry.
  // Full registration (handler + spec + promptDoc) — the
  // Orchestrator dispatcher routes automatically via
  // `this.nativeTools.get(name).handler` and the getTools() call picks
  // the spec live into the LLM-tool list. No orchestrator code touch.
  const disposeProcessMemoryTools: Array<() => void> = [];
  // Service-provider disposers, released on deactivate so a reactivate (e.g. a
  // provider switch via /admin/providers) can re-publish chatAgent@1 et al.
  // without a "duplicate provider" error. Without this, reactivating an already-
  // active orchestrator throws and leaves chat down.
  const disposeServices: Array<() => void> = [];
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

  // #576 P2 — `execute` native tool: a shell command runner backed by a
  // durable per-scope sandbox (`@omadia/sandbox`). Off by default — same
  // honest-inert opt-in convention as the #575 audience floor and #580
  // command policy, and for the sharpest reason of all of them: this tool's
  // entire job is running arbitrary commands, so a deployment that hasn't
  // explicitly turned it on must not get it "for free" from a default.
  // `executeTool.ts`'s handler runs its OWN org-floor command-policy check
  // independently of the turn-context `commandPolicy` seam (see that
  // module's doc) — belt AND braces, not a replacement for the existing
  // `guardToolCommands` choke point in `orchestrator.ts`'s `dispatchTool`.
  const disposeExecuteTool: Array<() => void> = [];
  const sandboxExecuteEnabled = ctx.config.get<boolean>('sandbox_execute_enabled') === true;
  if (sandboxExecuteEnabled) {
    const sandboxBackend = new DockerSandboxBackend();
    // No `writeCapabilities` annotation: that contract is a `{dataClass,
    // operation}` pair for canvas inline-edit + idempotency dedupe of
    // STRUCTURED writes (an Odoo record, a Jira ticket) — `execute`'s
    // effects are arbitrary and untyped, so neither half of the contract
    // fits, and re-running the "same" shell command is not safely
    // deduplicable the way replaying a structured write is. Deliberately
    // absent, not an oversight.
    disposeExecuteTool.push(
      nativeToolRegistry.register(EXECUTE_TOOL_NAME, {
        handler: createExecuteHandler({ backend: sandboxBackend }),
        spec: executeToolSpec,
        promptDoc: EXECUTE_SYSTEM_PROMPT_DOC,
      }),
    );
    ctx.log('[harness-orchestrator] sandbox_execute_enabled=true — registered execute native tool (Docker backend)');
  } else {
    ctx.log('[harness-orchestrator] sandbox_execute_enabled not set — skipping execute native tool');
  }

  // US3 — per-Agent Orchestrator construction. The orchestrator plugin
  // builds the single "default" Agent; the multi-orchestrator registry
  // (US4) calls the same factory once per configured Agent against the
  // same `deps`.
  const orchestratorDeps: OrchestratorDeps = {
    provider,
    knowledgeGraph,
    memoryStore,
    entityRefBus,
    nativeToolRegistry,
    nudgeRegistry,
    responseGuard: responseGuardGetter,
    privacyGuard: privacyGuardGetter,
    turnReceiptStore: turnReceiptStoreGetter,
    ...(pluginConfigGet ? { pluginConfigGet } : {}),
    ...(isPluginToolsReady ? { isPluginToolsReady } : {}),
    ...(contextRetriever ? { contextRetriever } : {}),
    ...(sessionBriefing ? { sessionBriefing } : {}),
    ...(factExtractor ? { factExtractor } : {}),
    ...(excerptExtractor ? { excerptExtractor } : {}),
    ...(embeddingClient ? { embeddingClient } : {}),
    ...(microsoft365 ? { microsoft365 } : {}),
    ...(verifierBundle ? { verifierBundle } : {}),
    ...(nudgeStateStore ? { nudgeStateStore } : {}),
    ...(processMemory ? { processMemory } : {}),
    autoPromote,
    autoPromoteThreshold,
    ...(autoPromoteDurableMinSignificance !== undefined
      ? { autoPromoteDurableMinSignificance }
      : {}),
    ...(graphPool ? { graphPool } : {}),
    graphTenantId,
    ...(assistantIdentity ? { assistantIdentity } : {}),
    ...(aiDisclosure ? { aiDisclosure } : {}),
    // #579 — org security posture (org floor + optional scope tighten + mode +
    // screen URL). Undefined → the orchestrator's shipping default (`auto`).
    ...(securityPosture ? { securityPosture } : {}),
    // #575 — the audience floor's grant store, published by the kernel only
    // when the operator enabled the floor. Absent is the normal case and means
    // the guards stay inert; see `OrchestratorDeps.audienceGrants`.
    ...(audienceGrants ? { audienceGrants } : {}),
    // #644 — one fold-dedup store for the whole process, shared by every Agent
    // the registry builds (same lifetime rationale as `directLineStickyStore`
    // below): a per-instance store would re-fold the marking into a live
    // conversation whenever an unrelated config tweak rebuilt the Agent.
    aiDisclosureSeenStore: new InMemoryDisclosureSeenStore(),
    ...(turnHookRegistry ? { turnHookRegistry } : {}),
    // #445 — one binding store for the whole process, shared by every Agent
    // the registry builds and rebuilt by none of them. Constructed
    // unconditionally: it is an empty Map until the flag is on, and holding it
    // in deps means toggling the flag at runtime never strands a binding in a
    // store that has been thrown away.
    directLineStickyStore: new InMemoryDirectLineStickyStore(),
    // W2-1 (#544) — the SAME store instance the kernel's `McpManager` parks
    // into, plus the replayer the kernel registered once it had a manager and a
    // server registry. Unconditional store (empty until something parks);
    // `buildOrchestrator` only enables the path when BOTH are present, so a
    // deployment without the kernel wiring stays fully inert.
    pendingMcpInput: sharedPendingMcpInputStore(),
    ...(sharedMcpInputReplayer()
      ? { mcpInputReplay: sharedMcpInputReplayer()! }
      : {}),
    attachmentReader,
  };
  // Per-turn Sonnet/Opus routing (opt-in). When `orchestrator_model_routing`
  // is true, a Haiku classifier picks the model per turn: simple → Sonnet,
  // complex → Opus. Models default to the existing orchestrator/sub-agent/
  // classifier config so it works out of the box once the flag is set.
  //
  // Provider-gated: per-turn routing assumes a single provider serving the
  // Claude model family (its defaults/fallbacks are claude-* ids). It is only
  // valid for Anthropic — under any other provider the one configured provider
  // would receive Claude model ids. Cross-provider per-turn routing is future
  // work; until then routing is suppressed for non-Anthropic providers.
  const modelRoutingEnabled =
    providerId === 'anthropic' &&
    (ctx.config.get<string>('orchestrator_model_routing') ?? '')
      .trim()
      .toLowerCase() === 'true';
  const modelRouting = modelRoutingEnabled
    ? {
        classifierModel:
          (
            ctx.config.get<string>('model_routing_classifier_model') ??
            ctx.config.get<string>('topic_classifier_model') ??
            'claude-haiku-4-5'
          ).trim(),
        simpleModel:
          (
            ctx.config.get<string>('model_routing_simple_model') ??
            ctx.config.get<string>('sub_agent_model') ??
            'claude-sonnet-4-6'
          ).trim(),
        complexModel:
          (
            ctx.config.get<string>('model_routing_complex_model') ?? model
          ).trim(),
      }
    : undefined;
  if (modelRouting) {
    console.log(
      `[harness-orchestrator] per-turn model routing ON (classifier=${modelRouting.classifierModel}, simple=${modelRouting.simpleModel}, complex=${modelRouting.complexModel})`,
    );
  }

  // #445 — sticky Direct Line. Read defensively: the installed-plugin config
  // may hold a real boolean (persisted by the install service) OR the string
  // the manifest/bootstrap seeds. `.trim()` on a boolean throws, and `?? ''`
  // does not protect because `false` is not nullish.
  const stickyRaw = ctx.config.get<unknown>('orchestrator_direct_line_sticky');
  const directLineSticky =
    stickyRaw === true || String(stickyRaw).trim().toLowerCase() === 'true';
  if (directLineSticky) {
    console.log(
      '[harness-orchestrator] direct-line sticky mode ON — a bare `#<agent>` binds the ' +
        'conversation until `#end`.',
    );
  }

  const built = buildOrchestratorForAgent(
    {
      agentId: 'default',
      model,
      ...(modelRouting ? { modelRouting } : {}),
      ...(directLineSticky ? { directLineSticky: true } : {}),
      maxTokens,
      maxToolIterations: maxIterations,
      ...(maxTurnSeconds > 0 ? { maxTurnSeconds } : {}),
      ...(loopRepeatSoft > 0 ? { loopRepeatSoft } : {}),
      ...(loopRepeatHard > 0 ? { loopRepeatHard } : {}),
    },
    orchestratorDeps,
  );
  disposeServices.push(ctx.services.provide(CHAT_AGENT_SERVICE, built.bundle));

  // US4 — multi-orchestrator registry. Optional: only when a Postgres pool
  // is available (test/in-memory boots skip it). The registry runs its own
  // migration, loads the config snapshot, and publishes itself as
  // `orchestratorRegistry@1` for US7 (channel routing) and US9 (operator UI).
  // The legacy `chatAgent@1` keeps serving the default boot path — the
  // registry sits alongside it. `graphPool` is already late-resolved at
  // the top of activate() (merged from main 2026-05-26).
  let registry: OrchestratorRegistry | undefined;
  let reloadBus: ReloadBus | undefined;
  if (graphPool) {
    try {
      await runMultiOrchestratorMigrations(graphPool, (m) =>
        ctx.log(`[harness-orchestrator] ${m}`),
      );
      const pluginLookup = ctx.services.get<PluginCapabilityLookup>(
        PLUGIN_CAPABILITIES_SERVICE,
      );
      const store = new ConfigStore(graphPool);
      // US9 / T037 — publish the configStore so the operator REST router
      // can perform writes without re-instantiating its own store
      // (singleton; cheaper than reconnecting, and write events flow
      // through the same trigger → reload-bus pipeline).
      disposeServices.push(ctx.services.provide(CONFIG_STORE_SERVICE, store));

      // US7 / T029 — first-boot fallback Agent seed. Runs before the
      // registry's `start()` so the very first boot already has a fallback
      // available for unbound channel keys.
      //
      // Phase B (B1) — when the kernel publishes `pluginCapabilities@1`
      // with `listInstalled()`, the fallback Agent is hydrated with every
      // installed plugin on first creation. Without the lookup (older
      // kernel boot, tests) it falls back to the legacy zero-plugin seed.
      const installedPluginIds = pluginLookup?.listInstalled?.();
      await ensureFallbackAgent(store, {
        log: (msg, fields) =>
          ctx.log(
            `[harness-orchestrator] ${msg}${fields ? ' ' + JSON.stringify(fields) : ''}`,
          ),
        ...(installedPluginIds
          ? { pluginIds: [...installedPluginIds] }
          : {}),
      });

      // SEAM (M3-followup): the `claude-cli` -> CliChatAgent swap lives in
      // buildOrchestratorForAgent (buildOrchestrator.ts), which both the
      // default `chatAgent@1` path and the US4 registry call via buildForAgent.
      // Registry-managed Agents are CLI-backed too; the remaining follow-up is
      // exposing sub-agent/kernel tools to the CLI dispatch (`domainTools: []`).
      registry = new OrchestratorRegistry(store, orchestratorDeps, {
        defaultRuntimeConfig: {
          model,
          ...(modelRouting ? { modelRouting } : {}),
          ...(directLineSticky ? { directLineSticky: true } : {}),
          maxTokens,
          maxToolIterations: maxIterations,
          ...(maxTurnSeconds > 0 ? { maxTurnSeconds } : {}),
          ...(loopRepeatSoft > 0 ? { loopRepeatSoft } : {}),
          ...(loopRepeatHard > 0 ? { loopRepeatHard } : {}),
        },
        ...(pluginLookup ? { pluginLookup } : {}),
        log: (msg, fields) =>
          ctx.log(
            `[harness-orchestrator] ${msg}${fields ? ' ' + JSON.stringify(fields) : ''}`,
          ),
      });
      await registry.start();
      disposeServices.push(
        ctx.services.provide(ORCHESTRATOR_REGISTRY_SERVICE, registry),
      );
      ctx.log(
        `[harness-orchestrator] orchestratorRegistry@1 published (agents=${String(registry.size())})`,
      );

      // US7 / T028 — publish the channel resolver so channel plugins can
      // route inbound webhooks per-binding. Opt-in: the legacy
      // `chatAgent@1` keeps serving anything that does not consume it.
      const resolver = new ChannelResolver({
        registry,
        log: (msg, fields) =>
          ctx.log(
            `[harness-orchestrator] ${msg}${fields ? ' ' + JSON.stringify(fields) : ''}`,
          ),
      });
      disposeServices.push(
        ctx.services.provide(CHANNEL_RESOLVER_SERVICE, resolver),
      );
      ctx.log('[harness-orchestrator] channelResolver@1 published');

      // US5 / T021 — LISTEN/NOTIFY hot-reload bus. Bound to the same pool
      // so the bus reserves one connection from the kg pool for the LISTEN
      // lifetime; no second connection string needed. Periodic reconcile
      // is the fallback for a dropped LISTEN connection (D3).
      reloadBus = new ReloadBus({
        pool: graphPool,
        reload: () => registry!.reload(),
        log: (msg, fields) =>
          ctx.log(
            `[harness-orchestrator] ${msg}${fields ? ' ' + JSON.stringify(fields) : ''}`,
          ),
      });
      await reloadBus.start();
    } catch (err) {
      ctx.log(
        `[harness-orchestrator] orchestratorRegistry NOT published — ${(err as Error).message}`,
      );
    }
  } else {
    ctx.log(
      '[harness-orchestrator] orchestratorRegistry SKIPPED — no graphPool (set DATABASE_URL to enable multi-orchestrator runtime)',
    );
  }

  ctx.log(
    `[harness-orchestrator] chatAgent@1 published (model=${model}, maxTokens=${String(maxTokens)}, maxIter=${String(maxIterations)}, verifier=${verifierBundle ? 'on' : 'off'}, calendar=${microsoft365 ? 'on' : 'off'}, contextRetriever=${contextRetriever ? 'on' : 'off'}, factExtractor=${factExtractor ? 'on' : 'off'}, palaiaExcerpt=${excerptExtractor ? 'on' : 'off'}, autoPromote=${autoPromote ? `on@${autoPromoteThreshold.toFixed(2)}` : 'off'}, durableAutoPromote=${autoPromoteDurableMinSignificance !== undefined ? `on@${autoPromoteDurableMinSignificance.toFixed(2)}` : 'off'}, embeddingClient=${embeddingClient ? 'on' : 'off'}, responseGuard=late-bound)`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('[harness-orchestrator] deactivating');
      if (reloadBus) {
        try {
          await reloadBus.stop();
        } catch {
          // best-effort
        }
      }
      try {
        disposeNudgeRegistry();
      } catch {
        // best-effort
      }
      // #648 — released like every other published service, so a reactivate
      // (the path a disclosure config change takes) can re-publish the posture
      // instead of failing with "duplicate provider".
      try {
        disposeDisclosurePosture();
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
      for (const dispose of disposeExecuteTool) {
        try {
          dispose();
        } catch {
          // best-effort
        }
      }
      // Release published services (chatAgent@1, orchestratorRegistry@1,
      // configStore, channelResolver) so a subsequent reactivate can re-publish
      // them — otherwise the provider switch fails with "duplicate provider".
      for (const dispose of disposeServices) {
        try {
          dispose();
        } catch {
          // best-effort
        }
      }
    },
  };
}
