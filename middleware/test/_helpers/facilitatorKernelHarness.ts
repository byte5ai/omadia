// Contract-suite harness (#2068, kernel half): the kernel's facilitator
// surface composed from the REAL modules over Postgres — config store,
// orchestrator registry and agent build, native tool registry, service
// registry with per-caller services, CoreApi, the archetype registry, the
// execution authorization (scopes and reservations), message hub, send
// services, agentTurn, readiness and session capabilities, and the operator
// routes — with three stand-ins at the edges:
//
//   - a SIMULATED CHANNEL of type 'teams' (the only type agents have their
//     own identities on): roster, readiness, send providers that record what
//     was sent and AS WHOM, and the emit side of CoreApi;
//   - a FIXTURE ENGINE plugin (kind `archetype`, delivers `facilitator`)
//     that reaches the kernel only through the service registry as itself
//     (`executionAuthorization`, `conversationMessages@2`, `agentTurn@2`,
//     `conversationSend@2`) and registers native tools. Like a real engine it
//     opens an execution scope for a process first, with the conversation as
//     the process's home, and everything it reads, runs and posts is that
//     process's;
//   - a SCRIPTED MODEL at the provider seam, recording every request.
//
// Booting twice over the same pool is a restart.

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Pool } from 'pg';

import type {
  ChannelReadinessProvider,
  MeetingSourceProvider,
  TargetedDeliveryOutcome,
} from '@omadia/channel-sdk';
import {
  ConfigStore,
  AgentGraphStore,
  archetypeAdds,
  FACILITATOR_ARCHETYPE,
  getArchetype,
  NativeToolRegistry,
  OrchestratorRegistry,
  type FacilitatorRuntimeLookup,
  type OrchestratorDeps,
} from '@omadia/orchestrator';
import {
  AGENT_TURN_V2_SERVICE_NAME,
  CHANNEL_READINESS_SERVICE_NAME,
  CONVERSATION_MESSAGES_V2_SERVICE_NAME,
  CONVERSATION_SEND_V2_SERVICE_NAME,
  EntityRefBus,
  EXECUTION_AUTHORIZATION_SERVICE_NAME,
  FACILITATION_ENGINE_CAPABILITY,
  InMemoryNudgeRegistry,
  SESSION_CAPABILITIES_SERVICE_NAME,
  type ArchetypeProcessesService,
  type ChannelReadinessService,
  type ExecutionAuthorizationService,
  type NativeToolCallContext,
  type ProcessConversationMessagesService,
  type ScopedAgentTurnService,
  type ScopedConversationSendService,
  type SessionCapabilitiesService,
  type TargetedSendService,
} from '@omadia/plugin-api';

import { publishAgentTurnService } from '../../src/agents/agentTurnWiring.js';
import { ConversationEventHub } from '../../src/channels/conversationEventHub.js';
import {
  wireConversationMessages,
  type ConversationMessagesWiring,
} from '../../src/channels/conversationMessages/wiring.js';
import {
  createFacilitatorRuntimeLookup,
  FACILITATOR_CONVERSATIONS_SERVICE,
} from '../../src/platform/facilitatorRuntimeService.js';
import { ConversationSendRegistry } from '../../src/channels/conversationSendRegistry.js';
import { createConversationSendService } from '../../src/channels/conversationSendService.js';
import { createCoreApi } from '../../src/channels/coreApi.js';
import { ConversationRosterRegistry } from '../../src/channels/rosterRegistry.js';
import { publishSendServices } from '../../src/channels/sendServicesWiring.js';
import { ChannelProviderRegistry } from '../../src/channels/sessionCapabilities/providerRegistry.js';
import { wireSessionCapabilities } from '../../src/channels/sessionCapabilities/wiring.js';
import { createTargetedDeliveryService } from '../../src/channels/targetedDeliveryService.js';
import { TargetedSendRegistry } from '../../src/channels/targetedSendRegistry.js';
import { wireExecutionAuthorization, type ExecutionWiring } from '../../src/execution/wiring.js';
import { createAgentEndOfService } from '../../src/platform/agentEndOfService.js';
import { createSystemNoticeOutbox, type SystemNoticeOutbox } from '../../src/platform/systemNoticeOutbox.js';
import { createArchetypeRegistrySync } from '../../src/platform/archetypeRegistrySync.js';
import { guardArchetypePluginUninstall } from '../../src/platform/archetypeUninstallGuard.js';
import { attachEngineToFacilitators } from '../../src/platform/facilitatorEngineAttach.js';
import {
  facilitatorGrantablePluginIds,
  type FacilitationEngineSources,
} from '../../src/platform/facilitatorGuard.js';
import { ObservedConversationInvites } from '../../src/platform/observedConversationInvites.js';
import { ServiceRegistry } from '../../src/platform/serviceRegistry.js';
import { createAgentBuilderRouter } from '../../src/routes/agentBuilder.js';
import { createOperatorAgentsRouter } from '../../src/routes/operatorAgents.js';
import { createOperatorDefaultAgentsRouter } from '../../src/routes/managementLayer.js';
import { listenLoopback } from './listenLoopback.js';
import { scriptedModel, type ScriptedModel } from './scriptedModel.js';

import type { FixtureEngine, FixtureProcess, PluginServices, SimulatedChannel } from './facilitatorKernelTypes.js';

export { systemText, type ModelStep, type ScriptedModel } from './scriptedModel.js';
export type {
  FixtureEngine,
  FixtureProcess,
  PluginServices,
  RecordedSend,
  SimulatedChannel,
} from './facilitatorKernelTypes.js';

export const ENGINE_PLUGIN = '@fixture/facilitation-engine';
export const BUSINESS_PLUGIN = '@fixture/crm';
export const CHANNEL_PLUGIN = '@fixture/channel-teams';
export const CHANNEL_TYPE = 'teams';

// ── the kernel ─────────────────────────────────────────────────────────────

export interface HarnessOptions {
  readonly pool: Pool;
  readonly installed?: readonly string[];
  readonly graceMs?: number;
  /** LISTEN for subscription changes of other kernels on the same database. */
  readonly listen?: boolean;
  /** Plugin statuses other than `active` (`inactive`, `errored`). */
  readonly statuses?: Record<string, string>;
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
  readonly execution: ExecutionWiring;
  readonly logs: string[];
  /** The installed plugins. Set it and call `propagateInstall` to install one;
   *  `uninstall` removes one the way the kernel does. */
  installed: string[];
  /** Set a plugin's status (`active`, `inactive`, `errored`). */
  setStatus(pluginId: string, status: string): void;
  /** What the engine plugin reports about itself (`undefined` = nothing). */
  setEngineState(state: unknown): void;
  /** A plugin other than the engine asking for the same services. */
  servicesAs(pluginId: string): PluginServices;
  /** Give an agent its own Teams identity (as provisioning would). */
  provisionIdentity(agentSlug: string, appId: string): Promise<string>;
  api(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }>;
  /** What the install hook does: register the archetype the plugin delivers,
   *  attach the engine to facilitators, reload. */
  propagateInstall(): Promise<void>;
  /** What the uninstall hook does for an archetype plugin, in its order: the
   *  agents of its archetype go out of service, every execution scope of the
   *  plugin ends, then the plugin's own `onUninstall` runs (its failure is
   *  caught, as `InstallService` does), then the plugin and its archetype
   *  descriptor are gone. */
  uninstall(pluginId: string, opts?: { readonly onUninstall?: () => Promise<void> }): Promise<void>;
  /** The engine's process service the end of service asks (`undefined` = it has none). */
  processes: ArchetypeProcessesService | undefined;
  /** The `system` notices owed outside a turn (criterion 37), on this database. */
  readonly notices: SystemNoticeOutbox;
  stop(): Promise<void>;
}

// The fixture engine's manifest states the archetype it delivers in full, as
// an archetype plugin's does. It is the kernel's own facilitator contract
// (read before any plugin registered one), so what a facilitator omits and
// gets is the same in this suite as on an instance without a descriptor from
// a plugin; what changes is WHO delivers the archetype, which is what the
// execution authorization asks.
const FACILITATOR_CONTRACT = getArchetype(FACILITATOR_ARCHETYPE)!;
const ENGINE_ARCHETYPE = {
  id: FACILITATOR_ARCHETYPE,
  omits: [...FACILITATOR_CONTRACT.omits],
  adds: [...(FACILITATOR_CONTRACT.adds ?? [])],
  requires: [...(FACILITATOR_CONTRACT.requires ?? [])],
  noun: FACILITATOR_CONTRACT.noun,
  ...(FACILITATOR_CONTRACT.omissionReasons ? { omissionReasons: FACILITATOR_CONTRACT.omissionReasons } : {}),
};

const PROVIDES: Record<string, { kind: string; provides: string[]; archetype?: typeof ENGINE_ARCHETYPE }> = {
  [ENGINE_PLUGIN]: { kind: 'archetype', archetype: ENGINE_ARCHETYPE, provides: [FACILITATION_ENGINE_CAPABILITY] },
  [BUSINESS_PLUGIN]: { kind: 'integration', provides: ['crm@1'] },
};

// The archetype descriptors are one registry per process, so one sync serves
// every kernel a test file boots (a restart, a second machine). It follows
// the kernel booted last; two kernels that run side by side have the same
// plugins installed.
const archetypeSources: { current: () => FacilitationEngineSources; pool?: Pool } = {
  current: () => ({ installedRegistry: undefined, catalog: undefined }),
};
const archetypeRegistry = createArchetypeRegistrySync({
  sources: () => archetypeSources.current(),
  rows: () => archetypeSources.pool,
});

/** Budget and deadline of the scopes the fixture engine opens: wide enough
 *  that no test runs into them by accident. */
const FIXTURE_BUDGET = { actions: 50, modelCalls: 50 };
const FIXTURE_DEADLINE_MS = 24 * 3_600_000;

export async function bootFacilitatorKernel(options: HarnessOptions): Promise<FacilitatorKernel> {
  const { pool } = options;
  const logs: string[] = [];
  const log = (m: string): void => void logs.push(m);
  const kernel = {
    installed: [...(options.installed ?? [ENGINE_PLUGIN, BUSINESS_PLUGIN])],
    statuses: { ...(options.statuses ?? {}) } as Record<string, string>,
    /** What the engine plugin reports about itself; `undefined` = nothing. */
    engineState: { pluginId: ENGINE_PLUGIN, version: '1.0.0', available: true } as unknown,
  };

  const engineSources = (): FacilitationEngineSources => ({
    installedRegistry: {
      list: () => kernel.installed.map((id) => ({ id, status: kernel.statuses[id] ?? 'active' })),
    } as never,
    catalog: {
      get: (id: string) => (PROVIDES[id] ? { plugin: { ...PROVIDES[id], id } } : undefined),
    } as never,
  });

  const services = new ServiceRegistry();
  const runtimeLookup = (): FacilitatorRuntimeLookup =>
    services.get<FacilitatorRuntimeLookup>(FACILITATOR_CONVERSATIONS_SERVICE)!;
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
      runtimeLookup().isEngineDriven(slug, channelType, conversationId),
    isFacilitationEngineUsable: (slug: string) => runtimeLookup().isEngineUsable(slug),
  } as unknown as OrchestratorDeps;
  const registry = new OrchestratorRegistry(store, deps, {
    defaultRuntimeConfig: { model: 'm', maxTokens: 512, maxToolIterations: 6 },
    pluginLookup: {
      isMultiInstance: () => true,
      isInstalled: (id: string) => kernel.installed.includes(id),
      facilitatorGrantable: () => facilitatorGrantablePluginIds(engineSources()),
    },
  });
  // An installed archetype plugin registers the archetype it delivers, before
  // any agent of it is built.
  archetypeSources.current = engineSources;
  archetypeSources.pool = pool;
  await archetypeRegistry.sync();
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

  // A holder: the services wired first ask for the message hub lazily.
  const wiring: { messages?: ConversationMessagesWiring } = {};
  services.provide(
    FACILITATOR_CONVERSATIONS_SERVICE,
    createFacilitatorRuntimeLookup({
      getRegistry,
      getMessages: () => wiring.messages?.hub,
      engineSources,
      reportedEngineState: () => kernel.engineState,
    }),
  );
  const capabilityHub = wireSessionCapabilities({
    serviceRegistry: services,
    readiness: readinessProviders,
    meetingSources,
    getRegistry,
    getMessages: () => wiring.messages?.hub,
    engineSources,
    log,
  });
  // Execution scopes and reservations, wired as the kernel's boot wires them:
  // what a process may read follows them at once.
  const execution = wireExecutionAuthorization({
    pool,
    serviceRegistry: services,
    getRegistry,
    configuringMaxHours: 72,
    sweepIntervalMs: 3_600_000,
    onAccessChanged: () => {
      void wiring.messages?.reconcileNow().catch((err: unknown) => {
        log(`[conversation-messages] reconcile after an access change failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    log,
  });
  const messagesWiring = await wireConversationMessages({
    pool,
    serviceRegistry: services,
    getRegistry,
    invites,
    engineSources,
    getConfigStore: () => store,
    listen: options.listen ?? false,
    reconcileIntervalMs: 3_600_000,
    checkReadiness: (type, conversation, key) => capabilityHub.checkIdentity(type, conversation, key),
    graceMs: options.graceMs ?? 60_000,
    maxAgeDays: 30,
    purgeIntervalMs: 3_600_000,
    processAccess: (process) => execution.store.processAccess(process),
    log,
  });
  wiring.messages = messagesWiring;
  publishAgentTurnService({
    serviceRegistry: services,
    getRegistry,
    messages: messagesWiring.hub,
    engineSources,
    executionFor: (pluginId) => execution.serviceFor(pluginId),
    maxTurnsPerMinute: 60,
    log,
  });
  const ownIdentity = {
    identityFor: (slug: string, channelType: string) => registry.channelIdentityFor(slug, channelType),
    subscriptions: messagesWiring.hub,
    archetypeAddsOwnIdentitySend: (slug: string) => archetypeAdds(registry.get(slug)?.agent, 'own_identity_send'),
    getRoster: (channelType: string, conversationId: string) => rosters.getRoster(channelType, conversationId),
  };
  publishSendServices({
    serviceRegistry: services,
    targeted: createTargetedDeliveryService({ providers: targetedProviders, ownIdentity, log }),
    conversation: createConversationSendService({ providers: conversationProviders, ownIdentity, log }),
    scoped: {
      executionFor: (pluginId) => execution.serviceFor(pluginId),
      direct: { providers: targetedProviders, ownIdentity, log },
      messages: () => messagesWiring.hub,
      readiness: (request) => capabilityHub.check(request),
      log,
    },
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
    supports: { asChannelKey: true, mentions: true, poll: true },
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
    supports: { asChannelKey: true },
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
  // Every service is the one the kernel provides under its versioned name,
  // asked for as the plugin: nothing here is built by hand.
  const servicesFor = (pluginId: string): PluginServices => {
    const as = { agentId: pluginId, pluginId };
    return {
      execution: services.get<ExecutionAuthorizationService>(EXECUTION_AUTHORIZATION_SERVICE_NAME, as)!,
      messages: services.get<ProcessConversationMessagesService>(CONVERSATION_MESSAGES_V2_SERVICE_NAME, as)!,
      agentTurn: services.get<ScopedAgentTurnService>(AGENT_TURN_V2_SERVICE_NAME, as)!,
      conversationSend: services.get<ScopedConversationSendService>(CONVERSATION_SEND_V2_SERVICE_NAME, as)!,
      targetedSend: services.get<TargetedSendService>('targetedSend', as)!,
    };
  };
  const caller = { agentId: ENGINE_PLUGIN, pluginId: ENGINE_PLUGIN };
  const own = servicesFor(ENGINE_PLUGIN);
  // A process as an engine starts one: `configuring` with the conversation as
  // its home (that takes the conversation's reservation), then `active` with
  // the conversation as the target it may post to.
  const openProcess = async (
    agentSlug: string,
    conversationId: string,
    channelType = CHANNEL_TYPE,
  ): Promise<FixtureProcess> => {
    const processId = `facilitation-${randomUUID()}`;
    const home = { channelType, conversationId };
    const configuring = await own.execution.openScope({
      agentSlug,
      processId,
      kind: 'configuring',
      budget: FIXTURE_BUDGET,
      home,
    });
    if (configuring.outcome !== 'opened') {
      throw new Error(`the configuring scope was refused: ${configuring.code}: ${configuring.message}`);
    }
    const active = await own.execution.openScope({
      agentSlug,
      processId,
      kind: 'active',
      deadline: new Date(Date.now() + FIXTURE_DEADLINE_MS).toISOString(),
      budget: FIXTURE_BUDGET,
      targets: [{ kind: 'conversation', ...home }],
    });
    if (active.outcome !== 'opened') {
      throw new Error(`the active scope was refused: ${active.code}: ${active.message}`);
    }
    return {
      processId,
      scopeId: active.scope.id,
      scope: { agentSlug, channelType, conversationId, processId },
      authorization: {
        scopeId: active.scope.id,
        processId,
        phase: 'active',
        purpose: 'moderation',
        emission: 'template',
      },
    };
  };
  const engine: FixtureEngine = {
    pluginId: ENGINE_PLUGIN,
    ...own,
    readiness: services.get<ChannelReadinessService>(CHANNEL_READINESS_SERVICE_NAME, caller)!,
    capabilities: services.get<SessionCapabilitiesService>(SESSION_CAPABILITIES_SERVICE_NAME, caller)!,
    toolCalls: [],
    started: [],
    openProcess,
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
    let process: FixtureProcess;
    try {
      process = await openProcess(context.agentSlug, context.conversationId, context.channelType);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    const outcome = await engine.messages.subscribe(process.scope, { mode: 'all' });
    if (outcome.outcome !== 'subscribed') return `Error: ${outcome.code}: ${outcome.message}`;
    engine.started.push(process);
    return 'facilitation started';
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
      getInstalledRegistry: () => engineSources().installedRegistry as never,
      getPluginCatalog: () => engineSources().catalog as never,
        getFacilitationEngineState: () => kernel.engineState,
    }),
  );
  app.use(
    '/builder',
    createAgentBuilderRouter({ getConfigStore: () => store, getGraphStore: () => graph, getRegistry }),
  );
  // #2055 — the default-agent table replaced `PUT /agents/fallback`.
  app.use(
    '/default-agents',
    createOperatorDefaultAgentsRouter({ getConfigStore: () => store, getRegistry }),
  );
  const server: Server = await listenLoopback(app);
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  // What takes an agent out of service, as the kernel composes it. The fixture
  // engine has no process service of its own, so the kernel's part is all
  // there is: the agent's subscriptions end and its scopes are revoked.
  // Criterion 37 — owed `system` notices go through the channel's shared bot.
  const notices = createSystemNoticeOutbox({
    pool: () => pool,
    send: async (channelType, conversationId, message) => {
      const provider = conversationProviders.get(channelType);
      if (!provider) return { delivered: false, reason: `no conversation sender for '${channelType}'` };
      const out = await provider.sendToConversation(conversationId, message);
      return out.outcome === 'delivered' ? { delivered: true } : { delivered: false, reason: `${out.code}: ${out.message}` };
    },
    locale: () => 'de',
    log,
  });
  const processHolder: { current: ArchetypeProcessesService | undefined } = { current: undefined };
  const endOfService = createAgentEndOfService({
    processesFor: (archetypeId) => (archetypeId === FACILITATOR_ARCHETYPE ? processHolder.current : undefined),
    endSubscriptionsOf: (agentSlug, reason) => messagesWiring.hub.endAllOf(agentSlug, reason),
    revokeExecution: async (agentId, reason) => {
      const revoked = await execution.store.revokeAll({ agentId }, reason);
      return { scopesEnded: revoked.scopes.length, reservationsReleased: revoked.reservations };
    },
    emitSystemNotice: (notice) => notices.emit(notice),
    processTimeoutMs: 2_000,
    log,
  });

  return {
    store,
    registry,
    services,
    nativeTools,
    model,
    channel,
    engine,
    messagesWiring,
    execution,
    logs,
    notices,
    get processes(): ArchetypeProcessesService | undefined {
      return processHolder.current;
    },
    set processes(next: ArchetypeProcessesService | undefined) {
      processHolder.current = next;
    },
    get installed(): string[] {
      return kernel.installed;
    },
    set installed(next: string[]) {
      kernel.installed = next;
    },
    setStatus(pluginId: string, status: string): void {
      kernel.statuses[pluginId] = status;
    },
    setEngineState(state: unknown): void {
      kernel.engineState = state;
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
      let json: Record<string, unknown>;
      try {
        json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        json = { raw: text };
      }
      return { status: res.status, json };
    },
    async propagateInstall() {
      await archetypeRegistry.sync();
      const changed = await attachEngineToFacilitators(store, engineSources(), log);
      if (changed.length > 0) await registry.reload();
    },
    async uninstall(pluginId, opts) {
      await guardArchetypePluginUninstall(pluginId, {
        sources: engineSources,
        agents: () => ({
          list: () => store.listAgents(),
          disable: async (id) => {
            await store.updateAgent(id, { status: 'disabled' });
          },
        }),
        endOfService,
        reload: () => registry.reload(),
        revokeExecutionOfPlugin: async (id, reason) => ({
          scopesEnded: (await execution.store.revokeAll({ pluginId: id }, reason)).scopes.length,
        }),
        log,
      });
      try {
        await opts?.onUninstall?.();
      } catch (err) {
        log(`[install] onUninstall hook failed for ${pluginId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      kernel.installed = kernel.installed.filter((id) => id !== pluginId);
      await archetypeRegistry.sync();
      await messagesWiring.reconcileNow();
    },
    async stop() {
      notices.stop();
      await notices.drain();
      execution.stop();
      await messagesWiring.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
