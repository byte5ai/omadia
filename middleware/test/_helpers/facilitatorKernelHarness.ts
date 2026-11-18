// Contract-suite harness (#2068, kernel half): the kernel's facilitator
// surface composed from the REAL modules over Postgres — config store,
// orchestrator registry and agent build, native tool registry, service
// registry with per-caller services, CoreApi, message hub, send services,
// agentTurn, readiness and session capabilities, and the operator routes —
// with three stand-ins at the edges:
//
//   - a SIMULATED CHANNEL of type 'teams' (the only type agents have their
//     own identities on): roster, readiness, send providers that record what
//     was sent and AS WHOM, and the emit side of CoreApi;
//   - a FIXTURE ENGINE plugin (extension kind, provides `facilitationEngine@1`)
//     that reaches the kernel only through the service registry as itself and
//     registers native tools;
//   - a SCRIPTED MODEL at the provider seam, recording every request.
//
// Booting twice over the same pool is a restart.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Pool } from 'pg';

import type {
  ChannelReadinessProvider,
  ConversationRoster,
  CoreApi,
  MeetingSourceProvider,
  TargetedDeliveryOutcome,
  TargetedMessage,
} from '@omadia/channel-sdk';
import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import {
  ConfigStore,
  AgentGraphStore,
  NativeToolRegistry,
  OrchestratorRegistry,
  type OrchestratorDeps,
} from '@omadia/orchestrator';
import {
  AGENT_TURN_SERVICE_NAME,
  CHANNEL_READINESS_SERVICE_NAME,
  CONVERSATION_MESSAGES_SERVICE_NAME,
  EntityRefBus,
  FACILITATION_ENGINE_CAPABILITY,
  InMemoryNudgeRegistry,
  SESSION_CAPABILITIES_SERVICE_NAME,
  type AgentTurnService,
  type ChannelReadinessReport,
  type ChannelReadinessService,
  type ConversationMessagesService,
  type ConversationSendService as PluginConversationSendService,
  type NativeToolCallContext,
  type SessionCapabilitiesService,
  type TargetedSendService,
} from '@omadia/plugin-api';

import { publishAgentTurnService } from '../../src/agents/agentTurnWiring.js';
import { ConversationEventHub } from '../../src/channels/conversationEventHub.js';
import {
  FACILITATOR_CONVERSATIONS_SERVICE,
  wireConversationMessages,
  type ConversationMessagesWiring,
} from '../../src/channels/conversationMessages/wiring.js';
import { ConversationSendRegistry } from '../../src/channels/conversationSendRegistry.js';
import { createConversationSendService } from '../../src/channels/conversationSendService.js';
import { createCoreApi } from '../../src/channels/coreApi.js';
import { ConversationRosterRegistry } from '../../src/channels/rosterRegistry.js';
import { publishSendServices } from '../../src/channels/sendServicesWiring.js';
import { ChannelProviderRegistry } from '../../src/channels/sessionCapabilities/providerRegistry.js';
import { wireSessionCapabilities } from '../../src/channels/sessionCapabilities/wiring.js';
import { createTargetedDeliveryService } from '../../src/channels/targetedDeliveryService.js';
import { TargetedSendRegistry } from '../../src/channels/targetedSendRegistry.js';
import { attachEngineToFacilitators } from '../../src/platform/facilitatorEngineAttach.js';
import { facilitatorGrantablePluginIds } from '../../src/platform/facilitatorGuard.js';
import { ObservedConversationInvites } from '../../src/platform/observedConversationInvites.js';
import { ServiceRegistry } from '../../src/platform/serviceRegistry.js';
import { createAgentBuilderRouter } from '../../src/routes/agentBuilder.js';
import { createOperatorAgentsRouter } from '../../src/routes/operatorAgents.js';
import { listenLoopback } from './listenLoopback.js';

export const ENGINE_PLUGIN = '@fixture/facilitation-engine';
export const BUSINESS_PLUGIN = '@fixture/crm';
export const CHANNEL_PLUGIN = '@fixture/channel-teams';
export const CHANNEL_TYPE = 'teams';

// ── scripted model ─────────────────────────────────────────────────────────

export type ModelStep =
  | { readonly text: string }
  | { readonly tool: string; readonly input?: unknown };

export interface ScriptedModel {
  readonly provider: LlmProvider;
  readonly requests: LlmRequest[];
  /** Queue the model's next answers, in order. */
  script(...steps: ModelStep[]): void;
}

export function systemText(request: LlmRequest): string {
  const system = request.system;
  if (system === undefined) return '';
  return typeof system === 'string' ? system : system.map((block) => block.text).join('\n\n');
}

export function scriptedModel(): ScriptedModel {
  const requests: LlmRequest[] = [];
  const queue: ModelStep[] = [];
  let callId = 0;
  const next = (request: LlmRequest): LlmResponse => {
    requests.push(request);
    const step = queue.shift();
    if (!step) throw new Error(`scripted model: no answer scripted for request ${String(requests.length)}`);
    callId += 1;
    const usage = { inputTokens: 1, outputTokens: 1 };
    return 'text' in step
      ? { content: [{ type: 'text', text: step.text }], finishReason: 'stop', model: 'm', usage }
      : {
          content: [{ type: 'tool_call', id: `call-${String(callId)}`, name: step.tool, input: step.input ?? {} }],
          finishReason: 'tool_calls',
          model: 'm',
          usage,
        };
  };
  const provider = {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: false,
      streaming: true,
      promptCaching: false,
      forcedToolChoice: true,
      parallelToolCalls: false,
    },
    complete: (request: LlmRequest): Promise<LlmResponse> => Promise.resolve(next(request)),
    stream: (): never => {
      throw new Error('scripted model: stream() is not scripted');
    },
  } as unknown as LlmProvider;
  return { provider, requests, script: (...steps) => void queue.push(...steps) };
}

// ── simulated channel ──────────────────────────────────────────────────────

export interface RecordedSend {
  readonly kind: 'conversation' | 'direct';
  readonly target: string;
  /** The identity the message went out as; `undefined` = the channel's default bot. */
  readonly asChannelKey: string | undefined;
  readonly message: TargetedMessage;
  readonly userRef?: unknown;
}

export interface SimulatedChannel {
  readonly core: CoreApi;
  readonly sent: RecordedSend[];
  rosters: Map<string, ConversationRoster>;
  readiness: ChannelReadinessReport | undefined;
  /** What the next send answers; reset to `delivered` after each send. */
  nextOutcome: TargetedDeliveryOutcome | undefined;
  /** A bot was added to a group conversation. */
  botAdded(conversationId: string): void;
}

// ── fixture engine plugin ──────────────────────────────────────────────────

export interface FixtureEngine {
  readonly pluginId: string;
  readonly messages: ConversationMessagesService;
  readonly agentTurn: AgentTurnService;
  readonly conversationSend: PluginConversationSendService;
  readonly targetedSend: TargetedSendService;
  readonly readiness: ChannelReadinessService;
  readonly capabilities: SessionCapabilitiesService;
  /** Every tool call the engine's tools received, with the kernel's context. */
  readonly toolCalls: { tool: string; input: unknown; context: NativeToolCallContext | undefined }[];
}

// ── the kernel ─────────────────────────────────────────────────────────────

export interface HarnessOptions {
  readonly pool: Pool;
  readonly installed?: readonly string[];
  readonly graceMs?: number;
}

export interface FacilitatorKernel {
  readonly store: ConfigStore;
  readonly registry: OrchestratorRegistry;
  readonly services: ServiceRegistry;
  readonly nativeTools: NativeToolRegistry;
  readonly model: ScriptedModel;
  readonly channel: SimulatedChannel;
  readonly engine: FixtureEngine;
  readonly messagesWiring: ConversationMessagesWiring;
  readonly logs: string[];
  installed: string[];
  /** A plugin other than the engine asking for the same services. */
  servicesAs(pluginId: string): {
    messages: ConversationMessagesService;
    agentTurn: AgentTurnService;
    conversationSend: PluginConversationSendService;
    targetedSend: TargetedSendService;
  };
  /** Give an agent its own Teams identity (as provisioning would). */
  provisionIdentity(agentSlug: string, appId: string): Promise<string>;
  api(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }>;
  /** What the install hook does: attach the engine to facilitators, reload. */
  propagateInstall(): Promise<void>;
  stop(): Promise<void>;
}

const PROVIDES: Record<string, { kind: string; provides: string[] }> = {
  [ENGINE_PLUGIN]: { kind: 'extension', provides: [FACILITATION_ENGINE_CAPABILITY] },
  [BUSINESS_PLUGIN]: { kind: 'integration', provides: ['crm@1'] },
};

export async function bootFacilitatorKernel(options: HarnessOptions): Promise<FacilitatorKernel> {
  const { pool } = options;
  const logs: string[] = [];
  const log = (m: string): void => void logs.push(m);
  const kernel = { installed: [...(options.installed ?? [ENGINE_PLUGIN, BUSINESS_PLUGIN])] };

  const engineSources = () => ({
    installedRegistry: { list: () => kernel.installed.map((id) => ({ id, status: 'active' })) } as never,
    catalog: {
      get: (id: string) => (PROVIDES[id] ? { plugin: { ...PROVIDES[id], id } } : undefined),
    } as never,
  });

  const services = new ServiceRegistry();
  const store = new ConfigStore(pool);
  const nativeTools = new NativeToolRegistry();
  const model = scriptedModel();

  const deps = {
    provider: model.provider,
    knowledgeGraph: {},
    memoryStore: {},
    entityRefBus: new EntityRefBus({}),
    nativeToolRegistry: nativeTools,
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
    assistantIdentity: 'You are the platform assistant.',
    isEngineDrivenConversation: (slug: string, channelType: string, conversationId: string) =>
      services.get<(a: string, b: string, c: string) => boolean>(FACILITATOR_CONVERSATIONS_SERVICE)?.(
        slug,
        channelType,
        conversationId,
      ) ?? false,
  } as unknown as OrchestratorDeps;
  const registry = new OrchestratorRegistry(store, deps, {
    defaultRuntimeConfig: { model: 'm', maxTokens: 512, maxToolIterations: 6 },
    pluginLookup: {
      isMultiInstance: () => true,
      isInstalled: (id: string) => kernel.installed.includes(id),
      facilitatorGrantable: () => facilitatorGrantablePluginIds(engineSources()),
    },
  });
  await registry.start();
  const getRegistry = (): OrchestratorRegistry => registry;

  // ── channel-side registries and hubs ─────────────────────────────────────
  const eventHub = new ConversationEventHub();
  const invites = new ObservedConversationInvites({});
  invites.attach(eventHub);
  const rosters = new ConversationRosterRegistry();
  const targetedProviders = new TargetedSendRegistry();
  const conversationProviders = new ConversationSendRegistry();
  const readinessProviders = new ChannelProviderRegistry<ChannelReadinessProvider>('readiness');
  const meetingSources = new ChannelProviderRegistry<MeetingSourceProvider>('meetingSource');

  let messagesWiring: ConversationMessagesWiring | undefined;
  const capabilityHub = wireSessionCapabilities({
    serviceRegistry: services,
    readiness: readinessProviders,
    meetingSources,
    getRegistry,
    getMessages: () => messagesWiring?.hub,
    engineSources,
    log,
  });
  messagesWiring = await wireConversationMessages({
    pool,
    serviceRegistry: services,
    getRegistry,
    invites,
    engineSources,
    checkReadiness: (type, conversation, key) => capabilityHub.checkIdentity(type, conversation, key),
    graceMs: options.graceMs ?? 60_000,
    maxAgeDays: 30,
    purgeIntervalMs: 3_600_000,
    log,
  });
  publishAgentTurnService({
    serviceRegistry: services,
    getRegistry,
    messages: messagesWiring.hub,
    engineSources,
    maxTurnsPerMinute: 60,
    log,
  });
  const ownIdentity = {
    identityFor: (slug: string, channelType: string) => registry.channelIdentityFor(slug, channelType),
    subscriptions: messagesWiring.hub,
    getRoster: (channelType: string, conversationId: string) => rosters.getRoster(channelType, conversationId),
  };
  publishSendServices({
    serviceRegistry: services,
    targeted: createTargetedDeliveryService({ providers: targetedProviders, ownIdentity, log }),
    conversation: createConversationSendService({ providers: conversationProviders, ownIdentity, log }),
  });

  const core = createCoreApi({
    dispatcher: {} as never,
    routes: {} as never,
    rosterRegistry: rosters,
    targetedSends: targetedProviders,
    conversationEvents: eventHub,
    conversationSends: conversationProviders,
    conversationMessages: messagesWiring.hub,
    readinessProviders,
    meetingSources,
    sessionCapabilities: capabilityHub,
  });

  // ── the simulated channel plugs in through CoreApi, like a real one ──────
  const channel: SimulatedChannel = {
    core,
    sent: [],
    rosters: new Map(),
    readiness: undefined,
    nextOutcome: undefined,
    botAdded(conversationId: string): void {
      core.emitConversationEvent!({
        kind: 'bot_added',
        channelId: CHANNEL_PLUGIN,
        channelType: CHANNEL_TYPE,
        conversationId,
        conversationType: 'group',
        members: [],
        occurredAt: new Date().toISOString(),
      });
    },
  };
  let sendSeq = 0;
  const answer = (): TargetedDeliveryOutcome => {
    sendSeq += 1;
    const outcome = channel.nextOutcome ?? { outcome: 'delivered', messageId: `sent-${String(sendSeq)}` };
    channel.nextOutcome = undefined;
    return outcome;
  };
  core.registerRosterProvider!(CHANNEL_PLUGIN, {
    channelType: CHANNEL_TYPE,
    getRoster: (conversationId) => Promise.resolve(channel.rosters.get(conversationId)),
  });
  core.registerReadinessProvider!(CHANNEL_PLUGIN, {
    channelType: CHANNEL_TYPE,
    check: () =>
      Promise.resolve(
        channel.readiness ?? { ready: true, installed: true, canReadAllMessages: true, canPost: true, missing: [] },
      ),
  });
  core.registerConversationSendProvider!(CHANNEL_PLUGIN, {
    channelType: CHANNEL_TYPE,
    sendToConversation: (conversationId, message, opts) => {
      channel.sent.push({ kind: 'conversation', target: conversationId, asChannelKey: opts?.asChannelKey, message });
      const outcome = answer();
      return Promise.resolve(
        outcome.outcome === 'delivered' && message.poll
          ? { ...outcome, cardMessageId: `card-of-${outcome.messageId ?? ''}` }
          : outcome,
      );
    },
  });
  core.registerTargetedSendProvider!(CHANNEL_PLUGIN, {
    channelType: CHANNEL_TYPE,
    sendToUser: (target, message, opts) => {
      channel.sent.push({
        kind: 'direct',
        target: target.principalId,
        asChannelKey: opts?.asChannelKey,
        message,
        userRef: target.userRef,
      });
      return Promise.resolve(answer());
    },
  });

  // ── the fixture engine: only the service registry, as itself ─────────────
  const caller = { agentId: ENGINE_PLUGIN, pluginId: ENGINE_PLUGIN };
  const servicesFor = (pluginId: string) => {
    const as = { agentId: pluginId, pluginId };
    return {
      messages: services.get<ConversationMessagesService>(CONVERSATION_MESSAGES_SERVICE_NAME, as)!,
      agentTurn: services.get<AgentTurnService>(AGENT_TURN_SERVICE_NAME, as)!,
      conversationSend: services.get<PluginConversationSendService>('conversationSend', as)!,
      targetedSend: services.get<TargetedSendService>('targetedSend', as)!,
    };
  };
  const engine: FixtureEngine = {
    pluginId: ENGINE_PLUGIN,
    ...servicesFor(ENGINE_PLUGIN),
    readiness: services.get<ChannelReadinessService>(CHANNEL_READINESS_SERVICE_NAME, caller)!,
    capabilities: services.get<SessionCapabilitiesService>(SESSION_CAPABILITIES_SERVICE_NAME, caller)!,
    toolCalls: [],
  };
  const registerTool = (
    name: string,
    owner: string,
    run: (input: unknown, context: NativeToolCallContext | undefined) => Promise<string>,
  ): void => {
    nativeTools.register(name, {
      spec: { name, description: name, input_schema: { type: 'object', properties: {} } },
      handler: run,
      agentId: owner,
      domain: 'fixture',
    } as never);
  };
  // `facilitation_start` does what an engine does on first contact: it takes
  // the conversation from the kernel's context, never from its input.
  registerTool('facilitation_start', ENGINE_PLUGIN, async (input, context) => {
    engine.toolCalls.push({ tool: 'facilitation_start', input, context });
    if (!context?.agentSlug || !context.channelType || !context.conversationId) {
      return 'Error: no conversation in the tool call context';
    }
    const outcome = await engine.messages.subscribe({
      agentSlug: context.agentSlug,
      channelType: context.channelType,
      conversationId: context.conversationId,
    });
    return outcome.outcome === 'subscribed' ? 'facilitation started' : `Error: ${outcome.code}: ${outcome.message}`;
  });
  registerTool('record_contribution', ENGINE_PLUGIN, async (input, context) => {
    engine.toolCalls.push({ tool: 'record_contribution', input, context });
    return 'recorded';
  });
  registerTool('crm_lookup', BUSINESS_PLUGIN, async () => 'customer data');

  // ── operator routes over HTTP ────────────────────────────────────────────
  const graph = new AgentGraphStore(pool);
  const app = express();
  app.use(express.json());
  app.use(
    '/agents',
    createOperatorAgentsRouter({
      getConfigStore: () => store,
      getRegistry,
      getChatSessionStore: () => undefined,
      getInstalledRegistry: () => engineSources().installedRegistry,
      getPluginCatalog: () => engineSources().catalog,
    }),
  );
  app.use(
    '/builder',
    createAgentBuilderRouter({ getConfigStore: () => store, getGraphStore: () => graph, getRegistry }),
  );
  const server: Server = await listenLoopback(app);
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  return {
    store,
    registry,
    services,
    nativeTools,
    model,
    channel,
    engine,
    messagesWiring,
    logs,
    get installed(): string[] {
      return kernel.installed;
    },
    set installed(next: string[]) {
      kernel.installed = next;
    },
    servicesAs: servicesFor,
    async provisionIdentity(agentSlug, appId) {
      const agent = await store.getAgentBySlug(agentSlug);
      if (!agent) throw new Error(`no agent ${agentSlug}`);
      await pool.query(
        `INSERT INTO agent_teams_identities (agent_id, bot_slug, display_name, state, app_id)
         VALUES ($1, $2, $2, 'installed', $3)
         ON CONFLICT (agent_id) DO UPDATE SET app_id = EXCLUDED.app_id`,
        [agent.id, agentSlug, appId],
      );
      await registry.reload();
      return `28:${appId.toLowerCase()}`;
    },
    async api(method, path, body) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        json = { raw: text };
      }
      return { status: res.status, json };
    },
    async propagateInstall() {
      const changed = await attachEngineToFacilitators(store, engineSources(), log);
      if (changed.length > 0) await registry.reload();
    },
    async stop() {
      messagesWiring!.purge.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
