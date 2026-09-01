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
import { MemoryBinder, type ContextMemoryMode } from './memoryBinder.js';
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
  /**
   * #914 — this Agent's authored behaviour text (`agent_identities.
   * instructions`, migration 0052), which REPLACES the platform-wide
   * `OrchestratorDeps.assistantIdentity` for this Agent.
   *
   * Same slot, not an additional block: `assistantIdentity` is the opening
   * section of the system prompt, and an agent whose operator wrote its
   * behaviour down means that text, not that text appended to a generic
   * one. Absent/blank → the platform identity, exactly as before.
   *
   * Per-turn persona skills (Wave 8) still win over both — they replace this
   * slot for one turn, which is what they always did.
   */
  readonly identityInstructions?: string;
  /**
   * #967 — the name this Agent answers to (`agent_identities.display_name`),
   * already trimmed and non-empty when present.
   *
   * A LAYER, NOT A SLOT. Unlike {@link identityInstructions}, this does not
   * replace the assistant identity — it is appended to whichever identity text
   * ends up applying. The name is one fact about the Agent; the identity is
   * everything else it should do, and an operator who only typed a name into
   * the Teams provisioning form has not asked to discard the platform's
   * behaviour text along with its name.
   *
   * Absent → the identity text is used verbatim, exactly as before.
   */
  readonly identityName?: string;
  /**
   * #967 follow-up — this Agent's authored SELF-DESCRIPTION
   * (`agent_identities.short_description` / `.long_description`, the operator's
   * "Steckbrief" tab), already trimmed and non-empty when present.
   *
   * LAYERS, LIKE THE NAME, NOT SLOTS. They say what the Agent IS; they never
   * replace what it was told to DO. See `withAgentIdentity` for the full
   * precedence and for why the accent colour and avatar are excluded.
   *
   * Absent → nothing is added and the prompt is byte-identical, which is what
   * keeps every Agent that predates the Steckbrief exactly where it was.
   */
  readonly identityShortDescription?: string;
  readonly identityLongDescription?: string;
  /**
   * W5 memory-ACL — per-Agent rollout switch for chat-context-scoped memory.
   * Read from the `agents.context_memory` column (migration 0050).
   *
   *  - `'off'` (DEFAULT, and what every existing row reports) — byte-identical
   *    to today: every turn gets the agent-private memory stack, whether or not
   *    its channel plugin sends a `TurnOrigin`.
   *  - `'enforce'` — context turns write into their own tier and READ the
   *    agent tier read-only, so existing knowledge stays quotable.
   *  - `'enforce-strict'` — full quarantine: a context turn cannot even read
   *    the agent tier.
   *
   * Off-by-default plus an optional `origin` is what makes this a no-flag-day
   * change: every combination of old/new middleware and old/new channel plugin
   * behaves exactly as it does today until an operator flips this.
   */
  readonly contextMemory?: ContextMemoryMode;
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
 * Fold an Agent's own name into the identity text it speaks with (#967).
 *
 * THE PROBLEM THIS SOLVES. `assistantIdentity` is the opening section of the
 * system prompt, and a deployment's platform identity introduces the platform's
 * assistant by name. A bot provisioned into Teams as `Messias` therefore went
 * on introducing itself under that platform name: outwardly one bot, inwardly
 * another, which reads to a user as two different things wearing one avatar.
 *
 * APPENDED, NEVER SUBSTITUTED. The identity text is prose an operator wrote;
 * there is no reliable way to find and replace a name inside it, and trying
 * would corrupt text that merely mentions the name. Stating the name last is
 * both safe and unambiguous — the closing instruction is the one that binds.
 *
 * ONLY THE NAME. No description, no persona, no tone: those belong to the
 * operator's identity form, and inventing them here would put words in an
 * agent's mouth that nobody authored. An Agent that has a name and nothing
 * else keeps every behaviour it had, and answers to its name.
 *
 * A blank or absent name returns the identity byte-for-byte, which is what
 * keeps the prompt (and its cache key) unchanged for every Agent that never
 * authored one.
 */
export function withAgentName(
  identity: string | undefined,
  name: string | undefined,
): string | undefined {
  const trimmedName = name?.trim();
  if (!trimmedName) return identity;
  const nameLine = `Dein Name ist ${trimmedName}. Stelle dich unter diesem Namen vor und verwende ihn, wenn du von dir sprichst — er gilt auch dann, wenn oben ein anderer Name für dich genannt wird.`;
  const trimmedIdentity = identity?.trim();
  return trimmedIdentity ? `${trimmedIdentity}\n\n${nameLine}` : nameLine;
}

/**
 * Fold an Agent's authored SELF-DESCRIPTION into the identity text (#967
 * follow-up) — the operator's "Steckbrief" tab: short and long description.
 *
 * THE PROBLEM THIS SOLVES. These two fields described the agent everywhere a
 * human looked — the Teams store listing, the app package, the operator UI —
 * and nowhere the agent could read. An operator who wrote "HR-Assistentin für
 * Urlaub und Zeiterfassung" got a bot that rendered that sentence in a catalog
 * and could not say it when asked what it does. The identity tabs are a promise
 * that what you type is what the agent becomes; this is the half of that
 * promise that was missing.
 *
 * APPENDED, NEVER SUBSTITUTED — same rule as {@link withAgentName}, and for a
 * stronger reason here. `instructions` (via `composed_prompt`) REPLACES the
 * platform identity outright, which is deliberate and stays (#914): it is the
 * operator saying "this agent behaves like THIS instead". A description is not
 * that. It says what the agent is, not how it works, so it can only ever be an
 * addition — folding it into the replacing slot would let a one-line Steckbrief
 * silently delete a deployment's whole configured behaviour.
 *
 * VERBATIM, UNDER A LABEL. The text is the operator's own; nothing is
 * paraphrased, summarised or expanded. The labels exist because raw prose
 * pasted after a system prompt reads as an instruction rather than as a fact
 * about the agent — the label is framing, not content, and an unauthored field
 * contributes no label and no line. Nothing is invented for an empty field.
 *
 * BOTH, WHEN BOTH ARE THERE. Short and long are not two drafts of one text —
 * the Teams manifest caps them at 80 and 4000 characters precisely because they
 * answer different questions ("what is this?" vs "what can it do?"). An agent
 * asked either question should be able to answer it, so neither is dropped in
 * favour of the other. Identical values are the operator's own repetition and
 * are left alone rather than silently de-duplicated.
 */
export function withAgentSelfDescription(
  identity: string | undefined,
  descriptions: {
    readonly shortDescription?: string | undefined;
    readonly longDescription?: string | undefined;
  },
): string | undefined {
  const short = descriptions.shortDescription?.trim();
  const long = descriptions.longDescription?.trim();
  const lines: string[] = [];
  if (short) lines.push(`Kurzbeschreibung deiner Rolle: ${short}`);
  if (long) lines.push(`Ausführliche Beschreibung deiner Rolle: ${long}`);
  if (lines.length === 0) return identity;
  const block = lines.join('\n\n');
  const trimmedIdentity = identity?.trim();
  return trimmedIdentity ? `${trimmedIdentity}\n\n${block}` : block;
}

/**
 * The whole per-Agent identity layer, composed in ONE place so the precedence
 * is stated once and cannot drift between callers (#914 / #967).
 *
 * THE ORDER IS THE CONTRACT:
 *
 *  1. BASE — the platform-wide `assistantIdentity`, REPLACED outright by the
 *     Agent's own `identityInstructions` when it authored any. That value is
 *     already `COALESCE(composed_prompt, instructions)`, so the Charakter
 *     (persona axes) and Grenzen (boundary presets + sycophancy guard) tabs are
 *     compiled into it upstream by `composeAgentIdentityPrompt` — they are NOT
 *     unused columns, and nothing here needs to re-derive them. Replacing is
 *     deliberate and unchanged: it is the operator saying "behave like this
 *     instead of like the platform default".
 *
 *  2. APPENDED — the Steckbrief (short, then long description). Facts about the
 *     agent, layered ON TOP of whichever text step 1 produced, because a
 *     description must never be able to delete configured behaviour.
 *
 *  3. APPENDED LAST — the name. Last word deliberately: an operator's prose (or
 *     the platform identity) may mention some other name, and the closing
 *     instruction is the one that binds. This is why the name goes AFTER the
 *     descriptions and not directly after the identity text — a long
 *     description that names a predecessor bot must still lose to the name the
 *     agent actually wears.
 *
 * CONFLICT RULE, in one sentence: later text wins over earlier text, and
 * nothing appended can remove what step 1 established.
 *
 * DELIBERATELY EXCLUDED. `accent_color` and the avatar are rendering decisions
 * — they exist so a human can tell two bots apart at a glance in Teams. A model
 * cannot act on either, and describing them in a prompt ("deine Akzentfarbe ist
 * #3B82F6") would spend tokens on a fact that can only produce noise, or worse,
 * invite the agent to talk about its own styling. They stay presentation-only
 * on purpose, not by oversight.
 *
 * An Agent that authored nothing gets the platform identity back byte for byte,
 * which is what keeps every pre-#914 deployment (and its prompt-cache key)
 * exactly where it was.
 */
export function withAgentIdentity(
  baseIdentity: string | undefined,
  authored: {
    readonly identityInstructions?: string | undefined;
    readonly identityName?: string | undefined;
    readonly identityShortDescription?: string | undefined;
    readonly identityLongDescription?: string | undefined;
  },
): string | undefined {
  // Step 1 — replace. A blank authored value is not an identity, so it falls
  // through rather than silencing the opening section of the system prompt.
  const base = authored.identityInstructions?.trim() || baseIdentity;
  // Steps 2 and 3 — append, descriptions before the name.
  return withAgentName(
    withAgentSelfDescription(base, {
      ...(authored.identityShortDescription !== undefined
        ? { shortDescription: authored.identityShortDescription }
        : {}),
      ...(authored.identityLongDescription !== undefined
        ? { longDescription: authored.identityLongDescription }
        : {}),
    }),
    authored.identityName,
  );
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

  // W5 memory-ACL — the per-CHAT-CONTEXT binder. `memoryToolHandler` above is
  // resolved once, here, for the whole process lifetime; the binder resolves a
  // stack per turn from the turn's `TurnOrigin` instead, so what an Agent
  // learns in team A is not quotable in team B.
  //
  // It is built unconditionally and gated by MODE, not by presence: with
  // `contextMemory: 'off'` — the default, and what every existing agent row
  // reports until an operator changes it — `forOrigin` ignores the origin and
  // returns the context-free stack, which is the same ScopedMemoryStore +
  // OrchestratorMemoryNamespacer + DurableRulesMemoryStore composition the
  // lines above build. One code path, so the rollout switch cannot drift away
  // from the thing it is switching.
  //
  // The binder takes `deps.memoryStore` UNDECORATED on purpose: it owns the
  // whole decorator chain, because the scope it enforces is what decides which
  // wrappers apply. `chatSessionStore` / `sessionLogger` keep the static
  // `scopedStore` — session transcripts stay shared under `core/sessions`
  // (decision A3a) and must not be partitioned by chat context.
  const memoryBinder = new MemoryBinder({
    agentSlug: config.agentId,
    root: deps.memoryStore,
    mode: config.contextMemory ?? 'off',
    ...(durableRulesHookEnabled
      ? {
          durableRules: {
            pool: deps.graphPool!,
            kg: deps.knowledgeGraph,
            tenantId: deps.graphTenantId ?? 'default',
            ...(deps.embeddingClient
              ? { embeddingClient: deps.embeddingClient }
              : {}),
            log: (msg: string): void => {
              console.error(msg);
            },
          },
        }
      : {}),
    log: (msg, fields): void => {
      console.error(
        `[security-audit] ${msg}${fields ? ` ${JSON.stringify(fields)}` : ''}`,
      );
    },
  });

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

  // #914 / #967 — this Agent's authored identity, layered over the platform
  // default. `withAgentIdentity` owns the whole precedence (replace, then
  // append the Steckbrief, then append the name last); see its doc comment for
  // why each field sits where it does and why the accent colour and avatar are
  // deliberately not in it.
  const assistantIdentityWithName = withAgentIdentity(deps.assistantIdentity, {
    ...(config.identityInstructions !== undefined
      ? { identityInstructions: config.identityInstructions }
      : {}),
    ...(config.identityName !== undefined
      ? { identityName: config.identityName }
      : {}),
    ...(config.identityShortDescription !== undefined
      ? { identityShortDescription: config.identityShortDescription }
      : {}),
    ...(config.identityLongDescription !== undefined
      ? { identityLongDescription: config.identityLongDescription }
      : {}),
  });

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
    memoryBinder,
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
    // #914 — the Agent's own behaviour text wins over the platform-wide one.
    // Resolved once, here, so the two call sites below cannot disagree about
    // which identity this Agent speaks with. #967 folds the Agent's name into
    // that same resolved value for the same reason.
    ...(assistantIdentityWithName
      ? { assistantIdentity: assistantIdentityWithName }
      : {}),
    // #967 — the SAME authored name, handed over separately as well. The
    // prompt is not the only place an Agent states who it is: the Art. 50
    // marking names the assistant too and is resolved behind the model, where
    // the prompt is deliberately out of reach. Without this it had only the
    // platform-wide `ai_disclosure_assistant_name` — one string for every
    // Agent — so each provisioned bot signed its answers with whichever single
    // name the operator had typed there.
    ...(config.identityName?.trim()
      ? { identityName: config.identityName.trim() }
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
          ...(assistantIdentityWithName
            ? { systemPrompt: assistantIdentityWithName }
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
