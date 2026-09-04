import { randomUUID } from 'node:crypto';

import type { Express, RequestHandler } from 'express';
import type { Pool } from 'pg';
import type { OrchestratorRegistry } from '@omadia/orchestrator';
import type { JsonObject, KnownRefs } from '@omadia/conductor-core';

import type { RoleHolderRegistry, RoleHolderSource } from '@omadia/channel-sdk';

import { runConductorMigrations } from './migrator.js';
import { buildRoleHolderRegistry, holdersOnly } from './roleHolderResolver.js';
import { ConductorWorkflowStore } from './workflowStore.js';
import { ConductorRunStore } from './runStore.js';
import type { ConductorRun } from './runStore.js';
import { ConductorAwaitStore } from './awaitStore.js';
import type { ConductorAwait } from './awaitStore.js';
import type { ApprovalReminder } from '@omadia/plugin-api';
import { ConductorRoleStore } from './roleStore.js';
import { ConductorScheduleStore } from './scheduleStore.js';
import { ConductorChannelBindingStore } from './channelBindingStore.js';
import { ConductorRunExecutor } from './runExecutor.js';
import { ConductorAwaitWorker } from './awaitWorker.js';
import type { ProactiveSenderLike } from './awaitWorker.js';
import { ConductorRunResumeWorker } from './runResumeWorker.js';
import { ConductorScheduleWorker } from './scheduleWorker.js';
import { ConductorEventRouter } from './eventRouter.js';
import { RealStepEffects } from './realStepEffects.js';
import { ConductorBuilderAgent } from './builderAgent.js';
import { createCompositeTemplateCatalog, loadTemplateCatalog } from './templateCatalog.js';
import type { CompositeTemplateCatalog } from './templateCatalog.js';
import { loadPatternCatalog } from './patternCatalog.js';
import type { PatternCatalog } from './patternCatalog.js';
import { ConductorEphemeralStore } from './ephemeralStore.js';
import { ConductorEphemeralRunService } from './ephemeralRunService.js';
import { ConductorEphemeralReaper } from './ephemeralReaper.js';
import { ConductorEphemeralAttachmentsStore } from './ephemeralAttachmentsStore.js';
import { createTemplateStore } from './templateStore.js';
import type { ConductorTemplateStore } from './templateStore.js';
import { createConductorRouter } from './routes.js';
import { ConductorFacilitationAdmin } from './facilitationAdmin.js';
import { ConductorSayService } from './sayService.js';
import type { AgentChannelIdentityResolver, ConductorSayDeps } from './sayService.js';
import { ConductorDiscussionService } from './discussionService.js';
import type { SecretVault } from '../secrets/vault.js';
import { ConductorWebhookEndpointStore } from './webhookEndpointStore.js';
import { ConductorWebhookSubscriptionStore } from './webhookSubscriptionStore.js';
import { ConductorWebhookDispatcher } from './webhookDispatcher.js';
import { ConductorWebhookRetryWorker } from './webhookRetryWorker.js';
import { assertOutboundUrlAllowed } from './webhookOutbound.js';
import type { ConductorWebhookInboundDeps } from '../routes/conductorWebhooksInbound.js';

/** Issue #437 — the run.completed/run.failed webhook payload shape. Shared between
 *  `notifyRunEnded`'s inline hook and the retry worker's reconciliation pass (below)
 *  so the two paths can never drift into delivering differently-shaped payloads for
 *  the same event. Best-effort workflow-slug/name enrichment: a lookup miss still
 *  delivers the bare run fields rather than dropping the event. */
async function buildRunEventPayload(run: ConductorRun, workflowStore: ConductorWorkflowStore): Promise<JsonObject> {
  const version = await workflowStore.getVersion(run.workflowVersionId).catch(() => null);
  const workflow = version ? await workflowStore.getById(version.workflowId).catch(() => null) : null;
  return {
    runId: run.id,
    status: run.status,
    workflowSlug: workflow?.slug ?? null,
    workflowName: workflow?.name ?? null,
    triggerKind: run.triggerKind,
    context: run.context,
  };
}

export { runConductorMigrations } from './migrator.js';
export { ConductorFacilitationAdmin } from './facilitationAdmin.js';
export type { FacilitationOverview } from './facilitationAdmin.js';
export { ConductorWorkflowStore } from './workflowStore.js';
export { ConductorRunStore } from './runStore.js';
export { ConductorAwaitStore } from './awaitStore.js';
export { ConductorRoleStore } from './roleStore.js';
export { ConductorRunExecutor, AwaitNotPendingError, AwaitResponderNotHolderError } from './runExecutor.js';
export { ConductorAwaitWorker } from './awaitWorker.js';
export { ConductorRunResumeWorker } from './runResumeWorker.js';
export { ConductorScheduleWorker } from './scheduleWorker.js';
export { ConductorScheduleStore } from './scheduleStore.js';
export { ConductorChannelBindingStore } from './channelBindingStore.js';
export { ConductorEventRouter } from './eventRouter.js';
export { StubStepEffects } from './stepEffects.js';
export { RealStepEffects } from './realStepEffects.js';
export type { StepEffects, StepExecution, StepMeta } from './stepEffects.js';
export { ConductorBuilderAgent, ConductorBuilderUnavailableError } from './builderAgent.js';
export type { ConductorBuilderTurnInput, ConductorBuilderTurnResult, BuilderChatMessage, TemplateProposal } from './builderAgent.js';
export { applyGraphPatches, emptyGraph } from './graphPatch.js';
export type { GraphPatch } from './graphPatch.js';
export { createConductorRouter } from './routes.js';
export { createTemplateStore, TemplateIdExistsError, TemplateInvalidError } from './templateStore.js';
export type { ConductorTemplateStore, TemplateRecord, TemplateStatus } from './templateStore.js';
export { createCompositeTemplateCatalog, loadTemplateCatalog, userTemplateVisible } from './templateCatalog.js';
export type { CompositeTemplateCatalog, TemplateSummary } from './templateCatalog.js';
export { ConductorWebhookEndpointStore, generateInboundDeliveryId } from './webhookEndpointStore.js';
export type { ConductorWebhookEndpoint, WebhookInboundOutcome } from './webhookEndpointStore.js';
export { ConductorWebhookSubscriptionStore } from './webhookSubscriptionStore.js';
export type { ConductorWebhookSubscription, ConductorWebhookDelivery, WebhookDeliveryStatus } from './webhookSubscriptionStore.js';
export { ConductorWebhookDispatcher } from './webhookDispatcher.js';
export { ConductorWebhookRetryWorker } from './webhookRetryWorker.js';
export { WEBHOOK_POST_ACTION_ID, invokeWebhookPostAction } from './webhookPostAction.js';
export { assertOutboundUrlAllowed, WebhookUrlNotAllowedError } from './webhookOutbound.js';
export { loadPatternCatalog } from './patternCatalog.js';
export type { PatternCatalog } from './patternCatalog.js';
export { ConductorEphemeralStore } from './ephemeralStore.js';
export type { ReapableWorkflow } from './ephemeralStore.js';
export {
  ConductorEphemeralRunService,
  EPHEMERAL_SLUG_PREFIX,
  PatternNotFoundError,
  EphemeralSlotsMissingError,
  EphemeralQuotaExceededError,
  EphemeralInvalidInputError,
} from './ephemeralRunService.js';
export type { CreateEphemeralRunInput, EphemeralRunHandle, EphemeralRunLimits } from './ephemeralRunService.js';
export { ConductorEphemeralReaper } from './ephemeralReaper.js';
export { ConductorEphemeralAttachmentsStore } from './ephemeralAttachmentsStore.js';
export type { EphemeralAttachment } from './ephemeralAttachmentsStore.js';

export { ConductorSayService, formatUtterance, stripFencedJson, SAY_TEXT_MAX_CHARS } from './sayService.js';
export type {
  AgentChannelIdentityResolver,
  ConductorSayInput,
  ConductorSayOutcome,
  ConductorSayDeps,
} from './sayService.js';
export {
  ConductorDiscussionService,
  DiscussionAgentHasNoIdentityError,
  DiscussionConversationBusyError,
  DiscussionInvalidInputError,
  DISCUSSION_PATTERN_ID,
  DISCUSSION_DEFAULT_TTL_MS,
} from './discussionService.js';
export type { StartDiscussionInput } from './discussionService.js';
export {
  ambientTurnFrom,
  createDiscussionsCapability,
  DiscussionNoConversationError,
  DiscussionUnknownOpenerError,
  DiscussionUnknownPartnerError,
} from './discussionHere.js';
export type {
  AmbientTurn,
  AmbientTurnResolver,
  ConductorDiscussionsCapability,
  DiscussionPartner,
  OpenerResolver,
  PartnerLister,
  StartDiscussionHereInput,
} from './discussionHere.js';
export {
  appendTranscript,
  renderTranscript,
  TRANSCRIPT_MAX_ENTRIES,
  TRANSCRIPT_TEXT_MAX_CHARS,
} from './transcript.js';
export type { TranscriptEntry } from './transcript.js';
export { createScopedRoleAssignments, FACILITATION_ROLE_PREFIX, RoleKeyOutOfScopeError } from './scopedRoleAssignments.js';
export type { ScopedRoleAssignments } from './scopedRoleAssignments.js';

export interface ConductorWiring {
  workflowStore: ConductorWorkflowStore;
  runStore: ConductorRunStore;
  awaitStore: ConductorAwaitStore;
  roleStore: ConductorRoleStore;
  scheduleStore: ConductorScheduleStore;
  channelBindingStore: ConductorChannelBindingStore;
  executor: ConductorRunExecutor;
  awaitWorker: ConductorAwaitWorker;
  resumeWorker: ConductorRunResumeWorker;
  scheduleWorker: ConductorScheduleWorker;
  eventRouter: ConductorEventRouter;
  builderAgent: ConductorBuilderAgent;
  /** DB-backed user-template store (#478). */
  templateStore: ConductorTemplateStore;
  /** Composite template catalog (bundled + user + plugin) — its plugin
   *  registration seam is what the plugin install service feeds (#478). */
  templateCatalog: CompositeTemplateCatalog;
  /** Issue #437 — inbound endpoints + outbound subscriptions/dispatcher/retry worker. */
  webhookEndpoints: ConductorWebhookEndpointStore;
  webhookSubscriptions: ConductorWebhookSubscriptionStore;
  webhookDispatcher: ConductorWebhookDispatcher;
  webhookRetryWorker: ConductorWebhookRetryWorker;
  /** #330 — curated patterns + create/start seam + lifecycle for agent-generated
   *  JIT workflows; the service is what `conductorEphemeralRuns` exposes to plugins. */
  patternCatalog: PatternCatalog;
  ephemeralStore: ConductorEphemeralStore;
  ephemeralRunService: ConductorEphemeralRunService;
  ephemeralReaper: ConductorEphemeralReaper;
  /** #330 B3 — THE role→holder registry (local assignment table + any external
   *  sources). Exposed so the kernel's targeted-delivery fan-out resolves
   *  through the same instance the executor uses for approvals: "who gets the
   *  report" and "who may approve" must never drift apart. */
  roleHolderRegistry: RoleHolderRegistry;
  /** #330 C2a — auto-provisioned binding/role rows tied to ephemeral workflows;
   *  consumed by the kernel's onEphemeralReaped cleanup + the agent-setup seam. */
  ephemeralAttachments: ConductorEphemeralAttachmentsStore;
  /** Starts an agent topic discussion in a bound conversation (the `discussion`
   *  pattern plus the conversation floor its `say` steps speak on). */
  discussionService: ConductorDiscussionService;
  /** Deps for the unauthenticated `/api/hooks/:endpointId` router, which is mounted
   *  much earlier in `index.ts` (before `express.json()`) via a forward reference —
   *  `index.ts` assigns this once `wireConductor` returns. */
  webhookInboundDeps: ConductorWebhookInboundDeps;
}

/**
 * Wire the Conductor subsystem into the kernel: run its migrations, construct its stores +
 * run executor (stub step effects for now), and mount the operator API behind requireAuth.
 * Called from the kernel boot inside the `graphPool` block — Conductor is inert on the
 * in-memory backend (no pool), exactly like routines / agent_schedules.
 */
export async function wireConductor(deps: {
  pool: Pool;
  app: Express;
  requireAuth: RequestHandler;
  /** resolves an Agent (orchestrator instance) by slug for agent steps. */
  getRegistry: () => OrchestratorRegistry | undefined;
  /** invokes a deterministic-action / connector tool by id for action steps. */
  invokeAction?: (toolId: string, input: unknown) => Promise<string | undefined>;
  /** lists registered deterministic-action / tool ids for the Designer's action-step picker. */
  listActions?: () => string[];
  /** read model of the event-emit catalog (declared `event_emit` capabilities) for the Designer. */
  eventCatalog?: { list(): string[]; byPluginId(): Record<string, string[]> };
  /** resolves a proactive sender for a channel (US5 reminders) — from the routines senderRegistry. */
  getProactiveSender?: (channel: string) => ProactiveSenderLike | undefined;
  /**
   * #333 phase 3 — external role→holder sources (Entra group, Odoo HR reporting line) unioned
   * with Conductor's own assignment table. Omit for local-only behaviour, which is what every
   * deployment has today: one source, never a partial lookup.
   *
   * Each source must be one the operator allowed; the registry rejects a duplicate id, so an
   * external source cannot shadow `conductor-local` and substitute its own approver list.
   */
  roleHolderSources?: readonly RoleHolderSource[];
  /** #330 round 4 — kernel roster registry accessor for the facilitation
   *  admin overview (participants column). Best-effort; omit on hosts
   *  without channel rosters. */
  getRoster?: (channelType: string, conversationId: string) => Promise<
    { participants: readonly { userRef: { id: string; displayName?: string }; isBot?: boolean }[]; partial?: boolean } | undefined
  >;
  /** #330 round 4 — durable audit trace for the destructive operator
   *  terminate. Late-bound thunk like auditRoleChange. */
  auditFacilitationTerminate?: (entry: { actor: string; actorUserId?: string; workflowId: string; slug: string; cancelledRuns: number }) => Promise<void>;
  /** Conversation-send providers, so a `say` step can publish an agent's turn
   *  into the chat. Omit on hosts without a channel plugin — agent dialogue
   *  then degrades to silent turns rather than failing the run. */
  conversationSendProviders?: ConductorSayDeps['providers'];
  /** Per-agent-scoped secret vault (issue #437) — inbound endpoint secrets and outbound
   *  subscription signing secrets live here under the `core:conductor` namespace, never
   *  in a Postgres column or an API response body beyond their one-time creation reply. */
  vault: SecretVault;
  /** #759 — audit sink for role-holder (baton) changes, wired to the kernel's
   *  AdminAuditLog. Late-bound thunk shape at the caller so boot order does
   *  not matter. */
  auditRoleChange?: (entry: {
    actor: string;
    roleKey: string;
    action: 'add' | 'remove';
    holderId: string;
    holdersAfter: string[];
  }) => Promise<void>;
  /** #330 — guardrails for agent-generated ephemeral workflows. Every field
   *  optional; defaults: TTL 24h (max 7d), 3 concurrent runs + 10 creates/hour
   *  per agent, 60s reaper poll. */
  ephemeral?: {
    defaultTtlMs?: number;
    maxTtlMs?: number;
    maxActivePerAgent?: number;
    maxCreatesPerHour?: number;
    reaperIntervalMs?: number;
  };
  /** #330 C2a — invoked on BOTH reap paths (terminal-state hook + TTL reaper)
   *  before the definition is disposed of, so auto-provisioned bindings/roles
   *  die with their workflow. Best-effort: a throw is logged, never blocks
   *  the reap. Implemented in src/index.ts — wireConductor has no ConfigStore. */
  onEphemeralReaped?: (workflow: { id: string; slug: string }) => Promise<void>;
  /** Global inbound kill switch (`CONDUCTOR_WEBHOOKS_ENABLED`). Default true. */
  webhooksEnabled?: boolean;
  /** Outbound delivery attempt cap + per-attempt timeout — defaults live in webhookDispatcher.ts. */
  webhookMaxAttempts?: number;
  webhookTimeoutMs?: number;
  /** Per-endpoint inbound rate limit (`CONDUCTOR_WEBHOOK_MAX_DELIVERIES_PER_MINUTE`),
   *  enforced atomically alongside the delivery-id dedupe. Default 60/minute. */
  webhookInboundMaxPerMinute?: number;
  /** Review finding — the middleware's own externally-reachable base URL
   *  (`CONDUCTOR_WEBHOOK_PUBLIC_BASE_URL` falling back to `PUBLIC_BASE_URL`), used to
   *  build the absolute inbound endpoint URL the operator UI displays. */
  webhookInboundBaseUrl?: string;
  log?: (msg: string) => void;
}): Promise<ConductorWiring> {
  const log = deps.log ?? (() => undefined);
  await runConductorMigrations(deps.pool, log);

  const workflowStore = new ConductorWorkflowStore(deps.pool);
  const runStore = new ConductorRunStore(deps.pool);
  const awaitStore = new ConductorAwaitStore(deps.pool);
  const roleStore = new ConductorRoleStore(deps.pool);
  // #333 phase 3 — role→holder resolution goes through a registry, with the local assignment
  // table registered as an ordinary source. `deps.roleHolderSources` is where an integration
  // (Entra group, Odoo HR reporting line) plugs in; empty today, so behaviour is unchanged.
  const roleHolderRegistry = buildRoleHolderRegistry(roleStore, deps.roleHolderSources ?? []);
  const scheduleStore = new ConductorScheduleStore(deps.pool);
  const channelBindingStore = new ConductorChannelBindingStore(deps.pool);

  // Issue #437 — webhooks. Built before the executor so `notifyRunEnded` can dispatch
  // outbound deliveries the moment a run reaches a terminal state.
  const webhookEndpoints = new ConductorWebhookEndpointStore(deps.pool, deps.vault);
  const webhookSubscriptions = new ConductorWebhookSubscriptionStore(deps.pool, deps.vault);
  const webhookDispatcher = new ConductorWebhookDispatcher({
    store: webhookSubscriptions,
    ...(deps.webhookMaxAttempts !== undefined ? { maxAttempts: deps.webhookMaxAttempts } : {}),
    ...(deps.webhookTimeoutMs !== undefined ? { timeoutMs: deps.webhookTimeoutMs } : {}),
    log,
  });
  // Issue #437 finding — `notifyRunEnded` below dispatches fire-and-forget AFTER the
  // run's terminal status is already committed; a process kill in that exact window
  // loses the webhook permanently (no delivery row is ever created for it). This
  // reconciliation pass finds terminal, non-dry-run runs from the last 24h with no
  // delivery row yet for an enabled subscription and creates the missing one(s) —
  // the already-running retry worker then delivers it on its next `claimDue` poll.
  // 24h is a generous restart-recovery window; the gap this closes is normally only
  // open for the length of a process restart.
  const WEBHOOK_RECONCILE_WINDOW_MS = 24 * 60 * 60 * 1000;
  const reconcileMissingWebhookDeliveries = async (): Promise<void> => {
    const sinceIso = new Date(Date.now() - WEBHOOK_RECONCILE_WINDOW_MS).toISOString();
    const missing = await webhookSubscriptions.listMissingRunDeliveries(sinceIso);
    for (const m of missing) {
      const run = await runStore.get(m.runId).catch(() => null);
      if (!run) continue; // shouldn't happen — the run this delivery would describe is gone
      const payload = await buildRunEventPayload(run, workflowStore);
      await webhookSubscriptions
        .createDelivery({ subscriptionId: m.subscriptionId, event: `run.${m.status}`, payload })
        .catch((err: unknown) => {
          log(`[conductor] webhook reconciliation: creating delivery for run ${m.runId} failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
  };

  const webhookRetryWorker = new ConductorWebhookRetryWorker({
    store: webhookSubscriptions,
    dispatcher: webhookDispatcher,
    reconcile: reconcileMissingWebhookDeliveries,
    log,
  });
  webhookRetryWorker.start();

  // #330 — ephemeral lifecycle store, built before the executor so the terminal
  // hook below can dispose of an agent-generated workflow the moment its run ends
  // (the reaper's TTL poll is the safety net, not the primary path).
  const ephemeralStore = new ConductorEphemeralStore(deps.pool);
  const ephemeralAttachments = new ConductorEphemeralAttachmentsStore(deps.pool);

  // Which bot IS this agent. Read live from the registry on every call: a
  // just-provisioned identity has to work without a restart, and a revoked one
  // has to stop working just as fast.
  const agentChannelIdentity: AgentChannelIdentityResolver = (agentSlug, channelType) =>
    deps.getRegistry()?.channelIdentityFor(agentSlug, channelType);
  // Shared disposal path (terminal-state hook, TTL reaper safety net, and the
  // operator's facilitation terminate — #330 round 4). Idempotent: an already
  // reaped or non-ephemeral workflow is a no-op.
  const disposeEphemeralWorkflow = async (workflowId: string, reason: string): Promise<void> => {
    const workflow = await workflowStore.getById(workflowId);
    if (workflow?.origin !== 'ephemeral' || workflow.reapedAt) return;
    // #330 C2a — dispose of auto-provisioned attachments (binding, role) first;
    // best-effort like the webhook dispatch, the TTL reaper is the safety net.
    if (deps.onEphemeralReaped) {
      await deps.onEphemeralReaped({ id: workflow.id, slug: workflow.slug }).catch((err: unknown) => {
        log(`[conductor] ephemeral attachment cleanup for '${workflow.slug}' failed (reap continues): ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    await ephemeralStore.markReaped(workflow.id);
    await ephemeralStore.hardDeleteUnreferenced(workflow.id);
    log(`[conductor] ephemeral '${workflow.slug}' reaped ${reason} (audit trace retained)`);
  };
  const reapIfEphemeral = async (workflowVersionId: string): Promise<void> => {
    const version = await workflowStore.getVersion(workflowVersionId);
    if (version) await disposeEphemeralWorkflow(version.workflowId, 'on terminal run state');
  };

  const executor = new ConductorRunExecutor({
    workflowStore,
    runStore,
    awaitStore,
    effects: new RealStepEffects({
      getRegistry: deps.getRegistry,
      ...(deps.invokeAction ? { invokeAction: deps.invokeAction } : {}),
      // The agent-dialogue seam: a `say` step's answer reaches the chat through
      // here. Absent providers = silent turns, never a failing run.
      ...(deps.conversationSendProviders
        ? {
            say: new ConductorSayService({
              attachments: ephemeralAttachments,
              providers: deps.conversationSendProviders,
              identityFor: agentChannelIdentity,
              log,
            }),
          }
        : {}),
      log,
    }),
    // #333 phase 3 — resolved through the holder registry rather than the assignment table
    // directly. With no external source activated this is byte-for-byte today's behaviour (one
    // source, never partial); once one is, the executor sees `partial` and refuses to complete a
    // quorum='all' or take a fallback on a holder list it could not fully read.
    resolveRoleHolders: (key) => roleHolderRegistry.resolveHolders(key),
    // Issue #437 — run-lifecycle outbound webhooks. Best-effort and fire-and-forget;
    // a delivery lost to a crash in this exact window is recovered by
    // `reconcileMissingWebhookDeliveries` above (issue #437 finding).
    notifyRunEnded: (run) => {
      const event = run.status === 'completed' ? 'run.completed' : 'run.failed';
      void (async () => {
        const payload = await buildRunEventPayload(run, workflowStore);
        await webhookDispatcher.deliverEvent(event, payload);
      })().catch((err: unknown) => {
        log(`[conductor] webhook dispatch for run ${run.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      // #330 — an ephemeral workflow is disposed of the moment its run reaches a
      // terminal state. Best-effort like the webhook dispatch: a miss here is
      // recovered by the reaper's poll, never lost.
      void reapIfEphemeral(run.workflowVersionId).catch((err: unknown) => {
        log(`[conductor] ephemeral reap after run ${run.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    log,
  });

  // Enriches a reminder with the structured approval payload (WHAT is being approved + the
  // workflow's current step/progress) so a channel that renders a rich approve/reject card can.
  // Best-effort: any miss returns undefined and the reminder still delivers its text fallback.
  const describeApproval = async (aw: ConductorAwait): Promise<ApprovalReminder | undefined> => {
    try {
      const run = await runStore.get(aw.runId);
      if (!run) return undefined;
      const version = await workflowStore.getVersion(run.workflowVersionId);
      if (!version) return undefined;
      const workflow = await workflowStore.getById(version.workflowId);
      // NB: we intentionally do NOT derive a "step X of Y" from `version.graph.steps` — that array is
      // authoring order, not execution order (the graph branches via transitions), so a fraction would
      // misread as linear progress. stepIndex/totalSteps stay reserved for a future run-trace-based
      // computation (review M2). "Where we are" is conveyed by the current step label.
      return {
        awaitId: aw.id,
        runId: aw.runId,
        question: aw.message,
        workflowName: workflow?.name || workflow?.slug || 'Workflow',
        stepLabel: aw.stepId,
        quorum: aw.quorum,
      };
    } catch {
      return undefined; // never block a reminder on enrichment
    }
  };

  // Deadline + reminder worker — fires the in-graph fallback on timeout (US5) and nudges waiting
  // holders on their channel when a reminder interval elapses (reminder deps optional / graphPool-gated).
  const awaitWorker = new ConductorAwaitWorker({
    awaitStore,
    executor,
    bindingStore: channelBindingStore,
    // Same registry as the executor, flattened to a list: nudging is the one consumer where a
    // partial lookup degrades safely — reminding fewer people is a missed nudge, not a wrong
    // decision, and the await's deadline still fires. `holdersOnly` marks that choice explicitly
    // rather than letting a `.holders` access hide it.
    resolveRoleHolders: holdersOnly((key) => roleHolderRegistry.resolveHolders(key)),
    ...(deps.getProactiveSender ? { getProactiveSender: deps.getProactiveSender } : {}),
    describeApproval,
    log,
  });
  awaitWorker.start();

  // Resume worker — re-drives runs orphaned by a process restart (US2 / SC-002).
  const resumeWorker = new ConductorRunResumeWorker({ runStore, executor, claimerId: randomUUID(), log });
  resumeWorker.start();

  // Schedule worker — fires workflows on their cron triggers (US4 cron).
  const scheduleWorker = new ConductorScheduleWorker({ scheduleStore, executor, log });
  scheduleWorker.start();

  // #330 — curated pattern catalog + the create/start seam agents get via the
  // `conductorEphemeralRuns` service, plus the TTL reaper (scheduleWorker discipline).
  const patternCatalog = loadPatternCatalog({ log });
  const ephemeralRunService = new ConductorEphemeralRunService({
    patterns: patternCatalog,
    workflowStore,
    ephemeralStore,
    executor,
    awaitStore,
    limits: {
      defaultTtlMs: deps.ephemeral?.defaultTtlMs ?? 24 * 60 * 60 * 1000,
      maxTtlMs: deps.ephemeral?.maxTtlMs ?? 7 * 24 * 60 * 60 * 1000,
      maxActivePerAgent: deps.ephemeral?.maxActivePerAgent ?? 3,
      maxCreatesPerHour: deps.ephemeral?.maxCreatesPerHour ?? 10,
    },
    log,
  });
  const discussionService = new ConductorDiscussionService({
    ephemeralRuns: ephemeralRunService,
    attachments: ephemeralAttachments,
    // The SAME resolver the say service uses — the start gate and the delivery
    // rule must answer "can this agent speak as itself" identically, or a
    // discussion passes the gate and then goes half-silent.
    identityFor: agentChannelIdentity,
    log,
  });
  const ephemeralReaper = new ConductorEphemeralReaper({
    store: ephemeralStore,
    ...(deps.onEphemeralReaped ? { onReaped: (wf: { id: string; slug: string }) => deps.onEphemeralReaped!(wf) } : {}),
    ...(deps.ephemeral?.reaperIntervalMs !== undefined ? { intervalMs: deps.ephemeral.reaperIntervalMs } : {}),
    log,
  });
  ephemeralReaper.start();

  // Event router — a domain event starts every subscribed workflow's run (US4).
  const eventRouter = new ConductorEventRouter({ workflowStore, executor, log });

  // Template surface (#429 bundled files + #478 DB store): one composite,
  // viewer-scoped catalog over both, plus the plugin registration seam.
  const templateStore = createTemplateStore(deps.pool, log);
  const templateCatalog = createCompositeTemplateCatalog({
    bundled: loadTemplateCatalog({ log }),
    store: templateStore,
    log,
  });

  // Live known-reference sets, shared by the STRICT template validation on the
  // resolve/instantiate routes AND the builder's proposal-prefill vetting (#478 B4)
  // — one definition so the two gates can never drift apart.
  const templateKnownRefs = async (): Promise<KnownRefs> => ({
    agentIds: (deps.getRegistry()?.list() ?? []).map((a) => a.agent.slug),
    actionIds: deps.listActions?.() ?? [],
    roleKeys: (await roleStore.listRoles()).map((r) => r.key),
    eventIds: deps.eventCatalog?.list() ?? [],
  });

  // Conversational builder agent (US7) — drives draft co-design via a registry Agent turn. Known
  // refs are sourced live from the event catalog so the builder + validate can flag unknown events.
  // #478 B4: the viewer-scoped composite catalog feeds its prompt digest + proposal allowlist.
  const builderAgent = new ConductorBuilderAgent({
    getRegistry: deps.getRegistry,
    knownRefs: () => ({ eventIds: deps.eventCatalog?.list() ?? [] }),
    templateCatalog,
    templateKnownRefs,
    log,
  });

  // #330 round 4 — operator lens + stop for live facilitations (invisible in
  // the library by design). Built on the SAME executor/disposal instances.
  const facilitationAdmin = new ConductorFacilitationAdmin({
    workflowStore,
    runStore,
    ephemeralAttachments,
    executor,
    disposeWorkflow: (workflowId) => disposeEphemeralWorkflow(workflowId, 'by operator terminate'),
    ...(deps.auditFacilitationTerminate ? { auditTerminate: deps.auditFacilitationTerminate } : {}),
    resolveRoleHolders: holdersOnly((key) => roleHolderRegistry.resolveHolders(key)),
    ...(deps.getRoster ? { getRoster: deps.getRoster } : {}),
    log,
  });

  deps.app.use(
    '/api/v1/operator/conductors',
    deps.requireAuth,
    createConductorRouter({
      workflowStore,
      runStore,
      awaitStore,
      facilitationAdmin,
      discussionService,
      roleStore,
      scheduleStore,
      executor,
      eventRouter,
      eventCatalog: deps.eventCatalog,
      // Live agent/action catalogs for the Designer's step pickers (dropdowns).
      agentCatalog: () => (deps.getRegistry()?.list() ?? []).map((a) => ({ slug: a.agent.slug, name: a.agent.name })),
      ...(deps.listActions ? { actionCatalog: deps.listActions } : {}),
      builderAgent,
      // Composite workflow-template catalog (#429 bundled + #478 user/plugin) + DB store.
      templateCatalog,
      templateStore,
      // Live known-reference sets for the STRICT template validation (stricter than 'POST /'
      // on purpose: a template instance must be runnable, not merely well-formed).
      templateKnownRefs,
      webhookEndpoints,
      webhookSubscriptions,
      ...(deps.auditRoleChange ? { auditRoleChange: deps.auditRoleChange } : {}),
      assertOutboundUrlAllowed: (url) => {
        assertOutboundUrlAllowed(url); // throws WebhookUrlNotAllowedError — route catches + 400s it
      },
      ...(deps.webhookInboundBaseUrl ? { webhookInboundBaseUrl: deps.webhookInboundBaseUrl } : {}),
    }),
  );

  // Issue #437 — deps for the unauthenticated inbound router mounted early in
  // `index.ts` (before `express.json()`, via a forward reference this wiring assigns).
  const webhookInboundRateLimit = { limit: deps.webhookInboundMaxPerMinute ?? 60, windowMs: 60_000 };
  const webhookInboundDeps: ConductorWebhookInboundDeps = {
    enabled: deps.webhooksEnabled ?? true,
    getEndpoint: async (endpointId) => {
      const ep = await webhookEndpoints.get(endpointId);
      return ep ? { eventId: ep.eventId, enabled: ep.enabled } : null;
    },
    getSecret: (endpointId) => webhookEndpoints.getSecret(endpointId),
    claim: (deliveryId, endpointId) => webhookEndpoints.claim(deliveryId, endpointId, webhookInboundRateLimit),
    setOutcome: (deliveryId, endpointId, outcome) => webhookEndpoints.setOutcome(deliveryId, endpointId, outcome),
    emit: (eventId, payload, source) => eventRouter.emit(eventId, payload, source),
    log,
  };

  return {
    workflowStore, runStore, awaitStore, roleStore, scheduleStore, channelBindingStore, executor, awaitWorker,
    resumeWorker, scheduleWorker, eventRouter, builderAgent, templateStore, templateCatalog,
    webhookEndpoints, webhookSubscriptions, webhookDispatcher, webhookRetryWorker, webhookInboundDeps,
    patternCatalog, ephemeralStore, ephemeralRunService, ephemeralReaper, roleHolderRegistry,
    ephemeralAttachments, discussionService,
  };
}
