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
  /** True when a store lookup failed while assembling this row — the row may
   *  UNDER-report (missing run/conversation/initiators), it never invents. */
  incomplete: boolean;
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
  /** Durable audit trace for the destructive terminate (review M1). */
  auditTerminate?: (entry: { actor: string; actorUserId?: string; workflowId: string; slug: string; cancelledRuns: number }) => Promise<void>;
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
    // Store hiccups must not hide the whole panel, but they must not read as
    // "no run / no conversation" either (review M2): every swallowed failure
    // is logged AND flagged, so the row says it may under-report.
    let incomplete = false;
    const soften = <T,>(what: string, fallback: T) => (err: unknown): T => {
      incomplete = true;
      this.deps.log?.(`[conductor] facilitation overview ${what} failed for '${wf.slug}': ${err instanceof Error ? err.message : String(err)}`);
      return fallback;
    };
    const attachments = await this.deps.ephemeralAttachments.getByWorkflow(wf.id).catch(soften('attachment lookup', []));
    const attachment = attachments[0];
    const runs = wf.activeVersionId
      ? await this.deps.runStore.listForVersion(wf.activeVersionId).catch(soften('run listing', []))
      : [];
    const latest = runs[0];

    let initiators: string[] = [];
    const roleKey = attachment?.roleKey ?? null;
    if (roleKey) {
      initiators = [...(await this.deps.resolveRoleHolders(roleKey).catch(soften('role-holder lookup', [])))];
    }

    let participants: FacilitationParticipant[] | null = null;
    let participantsPartial = false;
    if (attachment && this.deps.getRoster) {
      try {
        const roster = await this.rosterCached(attachment.channelType, attachment.channelKey);
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
      incomplete,
      run: latest ? runOverview(latest) : null,
      participants,
      participantsPartial,
    };
  }

  /** Roster lookups open a proactive channel turn — a short TTL cache keeps a
   *  panel refresh from multiplying outbound calls by row count (review M3). */
  private readonly rosterCache = new Map<string, { at: number; value: Awaited<ReturnType<NonNullable<FacilitationAdminDeps['getRoster']>>> }>();
  private static readonly ROSTER_CACHE_TTL_MS = 30_000;

  private async rosterCached(channelType: string, conversationId: string): Promise<Awaited<ReturnType<NonNullable<FacilitationAdminDeps['getRoster']>>>> {
    const key = `${channelType}::${conversationId}`;
    const hit = this.rosterCache.get(key);
    if (hit && Date.now() - hit.at < ConductorFacilitationAdmin.ROSTER_CACHE_TTL_MS) return hit.value;
    const value = await this.deps.getRoster!(channelType, conversationId);
    this.rosterCache.set(key, { at: Date.now(), value });
    return value;
  }

  /**
   * Operator stop: cancel every still-active run (waiting finalizes
   * immediately, running stops at the next step boundary — #759 semantics),
   * then dispose of the scaffold through the reaper's own cleanup path so
   * binding + role go with it. Idempotent for the happy path. When ANY
   * cancel fails, disposal is SKIPPED (review H1): stamping reaped_at would
   * hide a still-running facilitation from this very lens — the exact
   * invisibility incident this module exists to fix — so the row stays
   * visible and the operator retries.
   */
  async terminate(
    workflowId: string,
    actor: string,
    actorUserId?: string,
  ): Promise<
    | { outcome: 'not_found' }
    | { outcome: 'cancel_failed'; cancelledRuns: number; failedRuns: number }
    | { outcome: 'terminated'; cancelledRuns: number }
  > {
    const wf = await this.deps.workflowStore.getById(workflowId);
    if (!wf || wf.origin !== 'ephemeral') return { outcome: 'not_found' };
    let cancelled = 0;
    let failed = 0;
    if (wf.activeVersionId) {
      const runs = await this.deps.runStore.listForVersion(wf.activeVersionId).catch((err: unknown) => {
        this.deps.log?.(`[conductor] facilitation terminate run listing failed for '${wf.slug}': ${err instanceof Error ? err.message : String(err)}`);
        failed += 1;
        return [];
      });
      for (const run of runs) {
        if (run.status !== 'running' && run.status !== 'waiting') continue;
        try {
          await this.deps.executor.cancelRun(run.id, actor);
          cancelled += 1;
        } catch (err) {
          failed += 1;
          this.deps.log?.(`[conductor] facilitation cancel of run ${run.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (failed > 0) return { outcome: 'cancel_failed', cancelledRuns: cancelled, failedRuns: failed };
    // Dispose immediately instead of racing the terminal-state hook: the
    // operator asked for it gone NOW, and the disposal path is idempotent.
    await this.deps.disposeWorkflow(workflowId);
    // A destructive operator action leaves a durable trace (review M1) —
    // best-effort, never blocks the terminate itself.
    await this.deps
      .auditTerminate?.({ actor, ...(actorUserId ? { actorUserId } : {}), workflowId, slug: wf.slug, cancelledRuns: cancelled })
      .catch((err: unknown) => {
        this.deps.log?.(`[conductor] facilitation terminate audit failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    return { outcome: 'terminated', cancelledRuns: cancelled };
  }
}
