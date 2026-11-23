/**
 * #2082 — boot wiring of agent-owned triggers, kept out of `index.ts`:
 * the store, the service, the engine and its kernel executors, the proactive
 * gate, the agent tools, the event intake and the worker.
 */

import {
  currentDiscretion,
  currentDispatchCaller,
  fieldClassList,
  resolvedTurnLabels,
  turnContext,
  UNKNOWN_READERS,
} from '@omadia/orchestrator';
import type { AgentSpeaker, AnswerEmitter, DataPlanGuard, NativeToolSpec } from '@omadia/plugin-api';
import type { Pool } from 'pg';

import type { AuditEntryInput } from '../auth/adminAuditLog.js';
import { systemAuditActor } from '../auth/adminAuditLog.js';
import type { ProactiveSenderRegistry } from '../plugins/routines/proactiveSender.js';
import { isOwnBotAuthor } from './ownBot.js';
import { routineTurnContext } from '../plugins/routines/routineTurnContext.js';
import { WEB_ROUTINE_CHANNEL } from '../plugins/routines/webChatProactiveSender.js';
import { createDataActionRunner, type ReadToolsOf } from './dataActions.js';
import { createDeliverDataHandler, DELIVER_DATA_TOOL_NAME, deliverDataToolSpec } from './deliverDataTool.js';
import { createKernelExecutors, type AgentChat } from './kernelExecutors.js';
import type { RoutineTriggerScheduler } from './routineTriggers.js';
import type { ScheduleTriggerScheduler } from './scheduleTriggers.js';
import { createBatchExecutor, createBatchTriggerSync, type KernelBatchJobRegistry } from './batchJobs.js';
import { createProactiveGate, RecipientProfileStore, type RecipientProfile } from './proactiveGate.js';
import { TriggerEngine, type OperatorNotice, type TriggerAgentView } from './triggerEngine.js';
import type { TriggerLimits } from './triggerPolicy.js';
import { conversationContextId, TriggerService, type EventSource } from './triggerService.js';
import { TriggerStore } from './triggerStore.js';
import { createTriggerToolHandler, TRIGGER_TOOL_NAMES, triggerToolSpecs, type TriggerToolTurn } from './triggerTools.js';
import { TriggerWorker } from './triggerWorker.js';

const DAY_MS = 86_400_000;
const ROUTINE_SWEEP_MS = 3_600_000;

/** Events the kernel itself emits for every conversation it hears. */
export const KERNEL_EVENT_SOURCES: readonly EventSource[] = [
  { eventId: 'conversation.message.created', source: 'kernel' },
  { eventId: 'conversation.members.added', source: 'kernel' },
  { eventId: 'conversation.members.removed', source: 'kernel' },
];

export interface TriggerWiringDeps {
  readonly pool: Pool;
  readonly limits: TriggerLimits;
  readonly recipientDefaults: RecipientProfile;
  readonly enabled: boolean;
  readonly tickMs: number;
  readonly leaseMs: number;
  /** A live agent by slug (enabled or not), or undefined when it is not in service. */
  readonly agentBySlug: (slug: string) => TriggerAgentView | undefined;
  readonly agentChat: (slug: string) => AgentChat | undefined;
  /** The agent's speaker and single emitter (#2045), from its bundle. */
  readonly speakerOf?: (slug: string) => AgentSpeaker | undefined;
  readonly emitterOf?: (slug: string) => AnswerEmitter | undefined;
  /** The agent's own bot on a channel, to keep its messages off its hooks. */
  readonly ownChannelKey?: (slug: string, channel: string) => string | undefined;
  readonly readToolsOf: ReadToolsOf;
  /** The agent's boundary check of a data plan (spec 2042 §5.13 1a). */
  readonly dataPlanGuardOf?: (slug: string) => DataPlanGuard | undefined;
  /** The plugin ids granted to an agent (enabled grants). */
  readonly grantedPluginIds: (slug: string) => readonly string[];
  /** Declared emittable events per plugin id. */
  readonly eventCatalog: () => Readonly<Record<string, readonly string[]>>;
  /** Channel plugins: their events are offered to every agent. */
  readonly channelPluginIds: () => readonly string[];
  readonly senders: () => ProactiveSenderRegistry | undefined;
  readonly registerNativeTool: (
    name: string,
    handler: (input: unknown) => Promise<string>,
    options: { spec: NativeToolSpec; isAvailable: () => boolean },
  ) => () => void;
  readonly audit?: () => ((entry: AuditEntryInput) => Promise<void>) | undefined;
  /** Routines fire through their triggers (spec 2042 §5.12). */
  readonly routines?: () => RoutineTriggerScheduler | undefined;
  /** Agent Builder schedules fire through their triggers (spec 2042 §5.12). */
  readonly schedules?: () => ScheduleTriggerScheduler | undefined;
  /** Plugins' batch jobs (learning, consolidation) run as agent batch triggers. */
  readonly batchJobs?: KernelBatchJobRegistry;
  /** The agents in service, for batch triggers. */
  readonly enabledAgents?: () => readonly { readonly id: string; readonly slug: string }[];
  /** Injectable clock for tests. */
  readonly now?: () => Date;
  readonly log: (message: string) => void;
}

export interface TriggerWiring {
  readonly store: TriggerStore;
  readonly service: TriggerService;
  readonly profiles: RecipientProfileStore;
  readonly worker: TriggerWorker;
  /** Hand an event from any bus to the hooks. Never throws. */
  onEvent(eventId: string, payload: Readonly<Record<string, unknown>>, eventKey: string): void;
  /**
   * A channel's meeting lifecycle (spec 2042 §5.12 "Bound to a context"): a
   * meeting that ends ends its triggers, hooks and timers in one
   * transaction; a meeting that starts again in the same chat reopens it.
   * Never throws.
   */
  onSessionEvent(event: { readonly channelType: string; readonly conversationId: string; readonly kind: string }): Promise<void>;
  start(): void;
  stop(): void;
}

/** The trigger tools' view of the current turn, from the routines principal. */
function currentTurn(deps: TriggerWiringDeps): TriggerToolTurn | undefined {
  const ctx = routineTurnContext.current();
  if (!ctx) return undefined;
  const agentSlug = ctx.agentSlug ?? turnContext.currentAgentSlug() ?? currentDispatchCaller()?.agentSlug;
  if (!agentSlug) return undefined;
  const agent = deps.agentBySlug(agentSlug);
  if (!agent) return undefined;
  return {
    agentId: agent.id,
    agentSlug,
    tenant: ctx.tenant,
    userId: ctx.userId,
    channel: ctx.channel,
    conversationRef: ctx.conversationRef,
    discretion: async () => {
      const state = currentDiscretion();
      // No labelled turn (the claude-cli runtime): nothing was labelled.
      if (!state) return null;
      // A labelled turn without a room: what it read can go nowhere.
      if (state.contextKey === undefined) return { contextKey: 'unknown', readers: UNKNOWN_READERS, labels: state.labels };
      // A turn without origin is its owner's private context; its readers
      // are the owner's only where the trigger delivers into the owner's
      // own web chat. Anywhere else the room is not known: fail closed.
      const ownerOnly = state.contextKey.startsWith('owner:') && ctx.channel !== WEB_ROUTINE_CHANNEL;
      const readers = ownerOnly ? UNKNOWN_READERS : await state.resolveReaders();
      // The room's field rights travel with the trigger: its firings post
      // into this conversation and have no audience floor of their own.
      const fieldClasses = fieldClassList(await state.resolveFieldClasses());
      return { contextKey: state.contextKey, readers, labels: await resolvedTurnLabels(state), fieldClasses };
    },
  };
}

export function wireTriggers(deps: TriggerWiringDeps): TriggerWiring {
  const store = new TriggerStore(deps.pool);
  const profiles = new RecipientProfileStore(deps.pool);
  const dataActions = createDataActionRunner(deps.readToolsOf, deps.dataPlanGuardOf);
  const clock = deps.now ?? (() => new Date());
  const gate = createProactiveGate({
    profiles,
    defaults: deps.recipientDefaults,
    senders: deps.senders,
    ...(deps.ownChannelKey ? { ownChannelKey: deps.ownChannelKey } : {}),
    now: clock,
    log: deps.log,
  });

  const eventSources = (agentSlug: string): readonly EventSource[] => {
    const catalog = deps.eventCatalog();
    const plugins = new Set([...deps.grantedPluginIds(agentSlug), ...deps.channelPluginIds()]);
    const out: EventSource[] = [...KERNEL_EVENT_SOURCES];
    for (const [pluginId, ids] of Object.entries(catalog)) {
      if (!plugins.has(pluginId)) continue;
      for (const eventId of ids) out.push({ eventId, source: pluginId });
    }
    return out;
  };

  const service = new TriggerService({
    store,
    limits: deps.limits,
    eventSources,
    checkDataAction: (slug, action) => dataActions.check(slug, action),
    // A proactive message goes to the conversation it was born in, nowhere
    // else, until discretion labels can tell what may flow where (INV-9).
    targetAllowed: () => false,
    isOwnAuthor: (slug, channel, authorId) => isOwnBotAuthor(deps.ownChannelKey?.(slug, channel), authorId),
    now: clock,
    log: deps.log,
  });

  const notifyOperator = (notice: OperatorNotice): void => {
    deps.log(`[triggers] NOTICE ${notice.reason}: ${notice.message}`);
    // A routine's row follows a harness pause, so its owner sees it paused
    // (with the reason) and a restart does not lift the pause.
    if (notice.origin === 'routine' && notice.reason !== 'agent_unavailable' && notice.reason !== 'kill_switch') {
      void deps.routines?.()?.pausedByHarness(notice.contextId, notice.reason).catch(() => undefined);
    }
    const audit = deps.audit?.();
    void audit?.({
      actor: systemAuditActor('system:triggers'),
      action: 'trigger.notice',
      target: `trigger:${notice.triggerId}`,
      after: { agent: notice.agentSlug, purpose: notice.purpose, reason: notice.reason, message: notice.message },
    }).catch(() => undefined);
  };

  const engine = new TriggerEngine({
    store,
    limits: deps.limits,
    executors: createKernelExecutors({
      store,
      dataActions,
      gate,
      agentChat: deps.agentChat,
      speakerOf: (slug) => {
        const stamped = deps.speakerOf?.(slug);
        if (stamped) return stamped;
        const agent = deps.agentBySlug(slug);
        return agent
          ? { kind: 'agent', agentId: agent.id, slug: agent.slug, displayName: agent.displayName ?? agent.slug }
          : undefined;
      },
      ...(deps.emitterOf ? { emitterOf: deps.emitterOf } : {}),
      ...(deps.batchJobs ? { batch: createBatchExecutor(deps.batchJobs) } : {}),
      scheduleRan: async (trigger) => deps.schedules?.()?.ran(trigger),
      scheduleLive: async (trigger) => (await deps.schedules?.()?.isLive(trigger)) ?? false,
      routineTurn: async (trigger) => {
        const routines = deps.routines?.();
        return routines
          ? routines.fire(trigger)
          : { delivered: false, costUsd: 0, modelCalls: 0, error: 'routines are not wired' };
      },
    }),
    resolveAgent: deps.agentBySlug,
    sendWindow: (trigger, now) => gate.sendWindow(trigger, now),
    notifyOperator,
    now: clock,
    log: deps.log,
  });

  const worker = new TriggerWorker({
    store,
    engine,
    intervalMs: deps.tickMs,
    leaseMs: deps.leaseMs,
    maxAttempts: 3,
    // Fired one after another under one lease each (renewed before each):
    // a small batch keeps the tail of it from waiting long.
    batch: 5,
    enabled: () => deps.enabled,
    now: clock,
    log: deps.log,
  });

  const disposers: Array<() => void> = [];
  for (const name of TRIGGER_TOOL_NAMES) {
    disposers.push(
      deps.registerNativeTool(name, createTriggerToolHandler(name, { service, currentTurn: () => currentTurn(deps) }), {
        spec: triggerToolSpecs[name],
        // Only on a turn with a person's conversation: a trigger turn has
        // none, so a trigger cannot set further triggers.
        isAvailable: () => deps.enabled && routineTurnContext.current() !== undefined,
      }),
    );
  }

  // #2085 — the side channel inside a person's turn (spec 2042 §5.13). Not
  // tied to TRIGGERS_ENABLED: it is how an answer shows data, not a trigger.
  // Offered on every orchestrator turn (the only place a collector exists);
  // an agent without own read tools gets an honest refusal from the handler.
  disposers.push(
    deps.registerNativeTool(DELIVER_DATA_TOOL_NAME, createDeliverDataHandler({ dataActions }), {
      spec: deliverDataToolSpec,
      isAvailable: () => turnContext.current()?.dataSideChannel !== undefined,
    }),
  );

  const batchSync = deps.batchJobs
    ? createBatchTriggerSync({
        registry: deps.batchJobs,
        service: () => service,
        agents: () => deps.enabledAgents?.() ?? [],
        limits: () => deps.limits,
        now: clock,
        log: deps.log,
      })
    : undefined;

  let purgeTimer: ReturnType<typeof setInterval> | undefined;
  let routineTimer: ReturnType<typeof setInterval> | undefined;

  return {
    store,
    service,
    profiles,
    worker,
    onEvent(eventId, payload, eventKey) {
      if (!deps.enabled) return;
      void service.onEvent(eventId, payload, eventKey).catch((err: unknown) => {
        deps.log(`[triggers] event '${eventId}' could not reach the hooks: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    async onSessionEvent(event) {
      if (event.kind !== 'session_ended' && event.kind !== 'session_started') return;
      const contextId = conversationContextId(event.channelType, event.conversationId);
      try {
        if (event.kind === 'session_ended') await service.endContext('meeting', contextId);
        else await store.reopenContext('meeting', contextId);
      } catch (err) {
        deps.log(`[triggers] meeting ${contextId} (${event.kind}) could not reach its triggers: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    start() {
      if (!deps.enabled) {
        deps.log('[triggers] disabled (TRIGGERS_ENABLED=false): no trigger fires');
        return;
      }
      worker.start();
      purgeTimer = setInterval(() => {
        void profiles.purge(new Date(Date.now() - DAY_MS)).catch(() => undefined);
      }, 6 * 3_600_000);
      purgeTimer.unref();
      // Routines: ask owners before a deadline, pause the expired ones.
      const sweepRoutines = (): void => {
        void deps.routines?.()?.sweep().catch((err: unknown) => {
          deps.log(`[triggers] routine sweep failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      };
      // Schedules: arm new ones, end removed ones, disable expired ones.
      const syncSchedules = (): void => {
        void deps.schedules?.()?.sync().catch((err: unknown) => {
          deps.log(`[triggers] schedule sync failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      };
      const syncBatches = batchSync
        ? (): void => {
            void batchSync().catch((err: unknown) => {
              deps.log(`[triggers] batch sync failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
        : (): void => undefined;
      const sweep = (): void => {
        sweepRoutines();
        syncSchedules();
        syncBatches();
      };
      sweep();
      routineTimer = setInterval(sweep, ROUTINE_SWEEP_MS);
      routineTimer.unref();
    },
    stop() {
      worker.stop();
      if (purgeTimer) clearInterval(purgeTimer);
      if (routineTimer) clearInterval(routineTimer);
      for (const dispose of disposers) dispose();
    },
  };
}
