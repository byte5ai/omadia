// What an operator sees and stops of the runs agents started themselves
// (#2067). The library hides ephemeral workflows on purpose, so a running agent
// discussion is visible nowhere else. This lists them with what the run itself
// recorded (who opened it, who takes part, the topic, the conversation) and
// offers one operation: stop — cancel the active runs, then dispose of the
// workflow through the same path the reaper uses, which also releases the
// conversation.
//
// It replaces the facilitation lens: facilitations are processes of the
// facilitator plugin now and appear as execution scopes, not as Conductor
// workflows.

import type { JsonValue } from '@omadia/conductor-core';

import type { ConductorEphemeralAttachmentsStore } from './ephemeralAttachmentsStore.js';
import type { ConductorRun, ConductorRunStore } from './runStore.js';
import type { ConductorRunExecutor } from './runExecutor.js';
import type { ConductorWorkflow, ConductorWorkflowStore } from './workflowStore.js';

const TOPIC_MAX = 500;
const PARTICIPANTS_MAX = 20;
const SLUG_MAX = 128;

export interface RunningDiscussion {
  workflowId: string;
  slug: string;
  /** The agent that started the run. */
  openedBy: string | null;
  /** Agents taking part, as the run recorded them; empty when it recorded none. */
  participants: string[];
  topic: string | null;
  conversation: { channelType: string; conversationId: string } | null;
  status: ConductorRun['status'] | null;
  startedAt: string | null;
  /** Set once a stop was requested and the run has not reached a step boundary yet. */
  stopRequestedAt: string | null;
  expiresAt: string | null;
  /** True when a lookup failed while assembling this row: it may show less than
   *  there is, it never invents. */
  incomplete: boolean;
}

export type StopDiscussionResult =
  | { outcome: 'not_found' }
  | { outcome: 'cancel_failed'; cancelledRuns: number; failedRuns: number }
  | { outcome: 'stopped'; slug: string; cancelledRuns: number };

export interface DiscussionAdminDeps {
  workflowStore: Pick<ConductorWorkflowStore, 'listEphemeralActive' | 'getById'>;
  runStore: Pick<ConductorRunStore, 'listForVersion'>;
  ephemeralAttachments: Pick<ConductorEphemeralAttachmentsStore, 'getByWorkflow'>;
  executor: Pick<ConductorRunExecutor, 'cancelRun'>;
  /** The reaper's disposal path (attachment cleanup, reservation release, removal). */
  disposeWorkflow: (workflowId: string) => Promise<void>;
  log?: (msg: string) => void;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function text(value: JsonValue | undefined, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function slugs(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .slice(0, PARTICIPANTS_MAX)
    .map((entry) => entry.trim().slice(0, SLUG_MAX));
}

export class ConductorDiscussionAdmin {
  constructor(private readonly deps: DiscussionAdminDeps) {}

  async list(): Promise<RunningDiscussion[]> {
    const workflows = await this.deps.workflowStore.listEphemeralActive();
    return Promise.all(workflows.map((wf) => this.describe(wf)));
  }

  private async describe(wf: ConductorWorkflow): Promise<RunningDiscussion> {
    // A failed lookup must not hide the row, and must not read as "no run" or
    // "no conversation" either: it is logged and the row says so.
    let incomplete = false;
    const soften = <T,>(what: string, fallback: T) => (err: unknown): T => {
      incomplete = true;
      this.deps.log?.(`[conductor] discussion overview ${what} failed for '${wf.slug}': ${message(err)}`);
      return fallback;
    };
    const attachments = await this.deps.ephemeralAttachments.getByWorkflow(wf.id).catch(soften('attachment lookup', []));
    const runs = wf.activeVersionId
      ? await this.deps.runStore.listForVersion(wf.activeVersionId).catch(soften('run listing', []))
      : [];
    const attachment = attachments[0];
    const run = runs[0];
    const context: Record<string, JsonValue> = run?.context ?? {};
    // The run recorded the conversation itself; the attachment is the fallback
    // for a run that carries none.
    const channelType = attachment?.channelType ?? text(context['channelType'], SLUG_MAX);
    const conversationId = attachment?.channelKey ?? text(context['conversationId'], TOPIC_MAX);
    return {
      workflowId: wf.id,
      slug: wf.slug,
      openedBy: wf.createdByAgent ?? null,
      participants: slugs(context['participants']),
      topic: text(context['topic'], TOPIC_MAX),
      conversation: channelType && conversationId ? { channelType, conversationId } : null,
      status: run?.status ?? null,
      startedAt: iso(run?.startedAt),
      stopRequestedAt: iso(run?.cancelRequestedAt),
      expiresAt: iso(wf.expiresAt),
      incomplete,
    };
  }

  /**
   * Cancel every still-active run (a waiting run ends at once, a running one at
   * its next step boundary), then dispose of the workflow so the conversation
   * binding and the reservation go with it. When any cancel fails, nothing is
   * disposed: marking the workflow removed would hide a discussion that is
   * still running from this very list, so the row stays and the operator
   * retries.
   */
  async stop(workflowId: string, actor: string): Promise<StopDiscussionResult> {
    const wf = await this.deps.workflowStore.getById(workflowId);
    if (!wf || wf.origin !== 'ephemeral') return { outcome: 'not_found' };
    let cancelled = 0;
    let failed = 0;
    if (wf.activeVersionId) {
      const runs = await this.deps.runStore.listForVersion(wf.activeVersionId).catch((err: unknown) => {
        this.deps.log?.(`[conductor] discussion stop: run listing failed for '${wf.slug}': ${message(err)}`);
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
          this.deps.log?.(`[conductor] discussion stop: cancel of run ${run.id} failed: ${message(err)}`);
        }
      }
    }
    if (failed > 0) return { outcome: 'cancel_failed', cancelledRuns: cancelled, failedRuns: failed };
    await this.deps.disposeWorkflow(workflowId);
    return { outcome: 'stopped', slug: wf.slug, cancelledRuns: cancelled };
  }
}
