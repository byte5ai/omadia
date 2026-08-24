// Operator lens over RUNNING facilitations (#330 field report round 4): the
// library deliberately hides ephemeral workflows, which left live
// facilitations invisible in the admin UI — two instances ended up moderating
// the same meeting with no way to see or stop them. This module assembles the
// overview (conversation, goal/DoD from the durable run context, round count,
// latest fenced-JSON verdict, participants via the roster registry, initiator
// role holders) and offers ONE terminal operation: terminate — cancel the
// active runs, then dispose of the scaffold through the same cleanup path the
// reaper uses.

import type { JsonValue } from '@omadia/conductor-core';

import type { ConductorEphemeralAttachmentsStore } from './ephemeralAttachmentsStore.js';
import type { ConductorRun, ConductorRunStore } from './runStore.js';
import type { ConductorRunExecutor } from './runExecutor.js';
import type { ConductorWorkflow, ConductorWorkflowStore } from './workflowStore.js';

export interface FacilitationParticipant {
  displayName: string;
  isBot: boolean;
}

export interface FacilitationOverview {
  workflowId: string;
  slug: string;
  name: string;
  createdByAgent: string | null;
  expiresAt: string | null;
  conversation: { channelType: string; conversationId: string } | null;
  roleKey: string | null;
  /** Current holders of the initiator role — who receives the report. */
  initiators: string[];
  run: {
    id: string;
    status: ConductorRun['status'];
    startedAt: string | null;
    endedAt: string | null;
    cancelRequestedAt: string | null;
    currentStepId: string | null;
    goal: string | null;
    definitionOfDone: string | null;
    /** Assess rounds so far (executor-owned ctx.stepAttempts, never model-counted). */
    rounds: number;
    lastVerdict: { dodMet: boolean | null; summary: string | null } | null;
  } | null;
  participants: FacilitationParticipant[] | null;
  participantsPartial: boolean;
}

export interface FacilitationAdminDeps {
  workflowStore: ConductorWorkflowStore;
  runStore: ConductorRunStore;
  ephemeralAttachments: ConductorEphemeralAttachmentsStore;
  executor: Pick<ConductorRunExecutor, 'cancelRun'>;
  /** The reaper's disposal path (attachments cleanup + markReaped + hard delete). */
  disposeWorkflow: (workflowId: string) => Promise<void>;
  resolveRoleHolders: (roleKey: string) => Promise<readonly string[]>;
  /** Kernel roster registry — best-effort, a miss reads as "unknown". */
  getRoster?: (channelType: string, conversationId: string) => Promise<
    { participants: readonly { userRef: { id: string; displayName?: string }; isBot?: boolean }[]; partial?: boolean } | undefined
  >;
  log?: (msg: string) => void;
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}

function runOverview(run: ConductorRun): NonNullable<FacilitationOverview['run']> {
  const ctx = asRecord(run.context as JsonValue) ?? {};
  const attempts = asRecord(ctx['stepAttempts']);
  const verdictData = asRecord(asRecord(ctx['stepResult'])?.['data']);
  const rounds = typeof attempts?.['moderate'] === 'number' ? (attempts['moderate'] as number) : 0;
  const iso = (value: Date | string | null): string | null =>
    value == null ? null : value instanceof Date ? value.toISOString() : value;
  return {
    id: run.id,
    status: run.status,
    startedAt: iso(run.startedAt),
    endedAt: iso(run.endedAt),
    cancelRequestedAt: iso(run.cancelRequestedAt),
    currentStepId: run.currentStepId,
    goal: typeof ctx['goal'] === 'string' ? (ctx['goal'] as string) : null,
    definitionOfDone: typeof ctx['definitionOfDone'] === 'string' ? (ctx['definitionOfDone'] as string) : null,
    rounds,
    lastVerdict: verdictData
      ? {
          dodMet: typeof verdictData['dodMet'] === 'boolean' ? (verdictData['dodMet'] as boolean) : null,
          summary: typeof verdictData['summary'] === 'string' ? (verdictData['summary'] as string) : null,
        }
      : null,
  };
}

export class ConductorFacilitationAdmin {
  constructor(private readonly deps: FacilitationAdminDeps) {}

  async list(): Promise<FacilitationOverview[]> {
    const workflows = await this.deps.workflowStore.listEphemeralActive();
    return Promise.all(workflows.map((wf) => this.overview(wf)));
  }

  private async overview(wf: ConductorWorkflow): Promise<FacilitationOverview> {
    const attachments = await this.deps.ephemeralAttachments.getByWorkflow(wf.id).catch(() => []);
    const attachment = attachments[0];
    const runs = wf.activeVersionId
      ? await this.deps.runStore.listForVersion(wf.activeVersionId).catch(() => [])
      : [];
    const latest = runs[0];

    let initiators: string[] = [];
    const roleKey = attachment?.roleKey ?? null;
    if (roleKey) {
      initiators = [...(await this.deps.resolveRoleHolders(roleKey).catch(() => []))];
    }

    let participants: FacilitationParticipant[] | null = null;
    let participantsPartial = false;
    if (attachment && this.deps.getRoster) {
      try {
        const roster = await this.deps.getRoster(attachment.channelType, attachment.channelKey);
        if (roster) {
          participants = roster.participants.map((p) => ({
            displayName: p.userRef.displayName ?? p.userRef.id,
            isBot: p.isBot === true,
          }));
          participantsPartial = roster.partial === true;
        }
      } catch (err) {
        this.deps.log?.(`[conductor] facilitation roster lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      workflowId: wf.id,
      slug: wf.slug,
      name: wf.name,
      createdByAgent: wf.createdByAgent ?? null,
      expiresAt: wf.expiresAt ? new Date(wf.expiresAt).toISOString() : null,
      conversation: attachment ? { channelType: attachment.channelType, conversationId: attachment.channelKey } : null,
      roleKey,
      initiators,
      run: latest ? runOverview(latest) : null,
      participants,
      participantsPartial,
    };
  }

  /**
   * Operator stop: cancel every still-active run (waiting finalizes
   * immediately, running stops at the next step boundary — #759 semantics),
   * then dispose of the scaffold through the reaper's own cleanup path so
   * binding + role go with it. Idempotent: a second call is a no-op.
   */
  async terminate(workflowId: string, actor: string): Promise<{ cancelledRuns: number; disposed: boolean }> {
    const wf = await this.deps.workflowStore.getById(workflowId);
    if (!wf || wf.origin !== 'ephemeral') return { cancelledRuns: 0, disposed: false };
    let cancelled = 0;
    if (wf.activeVersionId) {
      const runs = await this.deps.runStore.listForVersion(wf.activeVersionId).catch(() => []);
      for (const run of runs) {
        if (run.status !== 'running' && run.status !== 'waiting') continue;
        try {
          await this.deps.executor.cancelRun(run.id, actor);
          cancelled += 1;
        } catch (err) {
          this.deps.log?.(`[conductor] facilitation cancel of run ${run.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    // Dispose immediately instead of racing the terminal-state hook: the
    // operator asked for it gone NOW, and the disposal path is idempotent.
    await this.deps.disposeWorkflow(workflowId);
    return { cancelledRuns: cancelled, disposed: true };
  }
}
