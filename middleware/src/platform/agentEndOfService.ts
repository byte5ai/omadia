// End of service of an agent (#2088, spec 2042 §5.10).
//
// Disabling an agent, deleting it, and removing the archetype plugin that
// delivers its archetype all take the agent out of service. Before the change
// takes effect the kernel ends what the agent was doing, in this order:
//
//   1. THE PLUGIN ENDS ITS PROCESSES, while the agent is still enabled and
//      the plugin still installed. The processes of an archetype (for a
//      facilitator: facilitations) are the plugin's; it closes each one
//      properly, which includes telling the conversation in the agent's own
//      voice that the process is over. That is the agent ending its own
//      work, not a `system` notice.
//   2. THE KERNEL ENDS EVERY MESSAGE SUBSCRIPTION of the agent itself,
//      whatever step 1 answered. From here nothing is delivered for the
//      agent, so a process the plugin failed to close cannot go on.
//   3. THE `system` NOTICE each affected home conversation is owed for an
//      agent that goes away: written to the outbox before the change happens
//      and posted once through the channel's shared bot, speaker `system`
//      (`systemNoticeOutbox.ts`). Nothing is posted under the agent's bot.
//   4. THE AUDIT says what happened to which agent and conversation.
//
// Then the caller changes the status, writes the tombstone or unloads the
// plugin. The procedure never throws: a step that fails is in the report and
// in the audit, and the change still happens. Leaving an agent in service
// because its plugin misbehaved would be the worse failure.

import type {
  AgentEndOfServiceReason,
  ArchetypeProcessEnded,
  ArchetypeProcessesService,
} from '@omadia/plugin-api';
import { archetypeOf, type ArchetypeBearer, type SystemNoticeRequest } from '@omadia/orchestrator';

import type { AuditActor, AuditEntryInput } from '../auth/adminAuditLog.js';

export interface EndOfServiceAgent extends ArchetypeBearer {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface EndedSubscription {
  readonly channelType: string;
  readonly conversationId: string;
}

export type ProcessEndOutcome =
  /** The plugin answered; `processes` lists what was running. */
  | 'ended'
  /** The archetype's plugin provides no service for this (or none is installed). */
  | 'not_supported'
  /** The service threw, or did not answer within the bound. */
  | 'failed';

export interface EndOfServiceReport {
  readonly agentId: string;
  readonly agentSlug: string;
  readonly agentName: string;
  readonly archetype: string;
  readonly reason: AgentEndOfServiceReason;
  readonly processOutcome: ProcessEndOutcome;
  /** Why step 1 is `failed`, for the operator. */
  readonly processDetail?: string;
  readonly processes: readonly ArchetypeProcessEnded[];
  readonly subscriptionsEnded: readonly EndedSubscription[];
  /** #2090 — execution scopes the kernel ended (none can authorize an action
   *  any more) and conversations whose reservation it released. */
  readonly scopesEnded: number;
  readonly reservationsReleased: readonly EndedSubscription[];
  /** `system` notices owed (one per affected conversation), handed to the outbox. */
  readonly noticesOwed: number;
}

export interface AgentEndOfServiceDeps {
  /** The process service of an archetype, from the plugin that delivers it. */
  readonly processesFor: (archetypeId: string) => ArchetypeProcessesService | undefined;
  /** Absent = no message store (no database): nothing to end. */
  readonly endSubscriptionsOf?: (agentSlug: string, reason: string) => Promise<readonly EndedSubscription[]>;
  /**
   * #2090 — end every execution scope and release every conversation
   * reservation of the agent. Runs after the plugin ended its processes (its
   * closing words still needed a scope) and whatever the plugin answered.
   * Absent = no database.
   */
  readonly revokeExecution?: (
    agentId: string,
    reason: string,
  ) => Promise<{ scopesEnded: number; reservationsReleased: readonly EndedSubscription[] }>;
  readonly audit?: (entry: AuditEntryInput) => Promise<void>;
  /** Called once per conversation that is owed a notice (the outbox). */
  readonly emitSystemNotice: (notice: SystemNoticeRequest) => void | Promise<void>;
  /** How long the plugin gets to end its processes. Default 20 s. */
  readonly processTimeoutMs?: number;
  readonly log?: (message: string) => void;
}

export const DEFAULT_PROCESS_END_TIMEOUT_MS = 20_000;

const REASON_TEXT: Record<AgentEndOfServiceReason, string> = {
  agent_disabled: 'agent disabled',
  agent_deleted: 'agent deleted',
  archetype_plugin_removed: 'archetype plugin removed',
};

const NOTICE_KIND: Record<AgentEndOfServiceReason, SystemNoticeRequest['kind']> = {
  agent_disabled: 'agent_disabled',
  agent_deleted: 'agent_deleted',
  archetype_plugin_removed: 'archetype_plugin_removed',
};

function isProcess(value: unknown): value is ArchetypeProcessEnded {
  if (value === null || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p['processId'] === 'string' &&
    typeof p['channelType'] === 'string' &&
    typeof p['conversationId'] === 'string' &&
    (p['outcome'] === 'aborted' || p['outcome'] === 'failed')
  );
}

/** Only fields of the contract, bounded: the report goes into the audit. */
function readProcesses(value: unknown): ArchetypeProcessEnded[] {
  const list = (value as { ended?: unknown } | null)?.ended;
  if (!Array.isArray(list)) return [];
  return list.filter(isProcess).slice(0, 200).map((p) => ({
    processId: p.processId.slice(0, 128),
    channelType: p.channelType.slice(0, 64),
    conversationId: p.conversationId.slice(0, 512),
    outcome: p.outcome,
    ...(typeof p.reportPosted === 'boolean' ? { reportPosted: p.reportPosted } : {}),
    ...(typeof p.detail === 'string' && p.detail.length > 0 ? { detail: p.detail.slice(0, 500) } : {}),
  }));
}

export interface AgentEndOfService {
  /** Take `agent` out of service. Never throws. */
  run(agent: EndOfServiceAgent, reason: AgentEndOfServiceReason, actor: AuditActor): Promise<EndOfServiceReport>;
}

export function createAgentEndOfService(deps: AgentEndOfServiceDeps): AgentEndOfService {
  const log = deps.log ?? (() => undefined);
  const timeoutMs = deps.processTimeoutMs ?? DEFAULT_PROCESS_END_TIMEOUT_MS;

  async function endProcesses(
    agent: EndOfServiceAgent,
    reason: AgentEndOfServiceReason,
  ): Promise<Pick<EndOfServiceReport, 'processOutcome' | 'processDetail' | 'processes'>> {
    let service: ArchetypeProcessesService | undefined;
    try {
      service = deps.processesFor(archetypeOf(agent));
    } catch {
      service = undefined;
    }
    if (!service || typeof service.endProcessesOfAgent !== 'function') {
      return { processOutcome: 'not_supported', processes: [] };
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const answer = await Promise.race([
        service.endProcessesOfAgent({ agentSlug: agent.slug, reason }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`no answer within ${String(timeoutMs)} ms`)),
            timeoutMs,
          );
        }),
      ]);
      return { processOutcome: 'ended', processes: readProcesses(answer) };
    } catch (err) {
      const detail = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      log(`[end-of-service] the archetype plugin did not end the processes of '${agent.slug}': ${detail}`);
      return { processOutcome: 'failed', processDetail: detail, processes: [] };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    async run(agent, reason, actor) {
      const archetype = archetypeOf(agent);
      const processes = await endProcesses(agent, reason);

      let subscriptionsEnded: readonly EndedSubscription[] = [];
      try {
        subscriptionsEnded =
          (await deps.endSubscriptionsOf?.(agent.slug, REASON_TEXT[reason]))?.map((s) => ({
            channelType: s.channelType,
            conversationId: s.conversationId,
          })) ?? [];
      } catch (err) {
        log(
          `[end-of-service] ending the subscriptions of '${agent.slug}' failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      let scopesEnded = 0;
      let reservationsReleased: readonly EndedSubscription[] = [];
      try {
        const revoked = await deps.revokeExecution?.(agent.id, REASON_TEXT[reason]);
        scopesEnded = revoked?.scopesEnded ?? 0;
        reservationsReleased =
          revoked?.reservationsReleased.map((r) => ({
            channelType: r.channelType,
            conversationId: r.conversationId,
          })) ?? [];
      } catch (err) {
        log(
          `[end-of-service] revoking the execution scopes of '${agent.slug}' failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // One notice per conversation that loses the agent: where a process
      // ended, where the agent was receiving messages, and where it held the
      // reservation.
      const conversations = new Map<string, { channelType: string; conversationId: string; processId?: string }>();
      for (const s of subscriptionsEnded) conversations.set(`${s.channelType}\n${s.conversationId}`, s);
      for (const r of reservationsReleased) conversations.set(`${r.channelType}\n${r.conversationId}`, r);
      for (const p of processes.processes) {
        conversations.set(`${p.channelType}\n${p.conversationId}`, {
          channelType: p.channelType,
          conversationId: p.conversationId,
          processId: p.processId,
        });
      }
      for (const conversation of conversations.values()) {
        try {
          await deps.emitSystemNotice({
            kind: NOTICE_KIND[reason],
            channelType: conversation.channelType,
            channelKey: conversation.conversationId,
            agentId: agent.id,
            agentName: agent.name,
            agentSlug: agent.slug,
            ...(conversation.processId !== undefined ? { processId: conversation.processId } : {}),
          });
        } catch {
          // The seam must not stop an end of service.
        }
      }

      const report: EndOfServiceReport = {
        agentId: agent.id,
        agentSlug: agent.slug,
        agentName: agent.name,
        archetype,
        reason,
        ...processes,
        subscriptionsEnded,
        scopesEnded,
        reservationsReleased,
        noticesOwed: conversations.size,
      };
      try {
        await deps.audit?.({
          actor,
          action: 'agent.end_of_service',
          target: `agent:${agent.id}`,
          after: {
            slug: agent.slug,
            name: agent.name,
            archetype,
            reason,
            process_outcome: report.processOutcome,
            ...(report.processDetail !== undefined ? { process_detail: report.processDetail } : {}),
            processes: report.processes,
            subscriptions_ended: report.subscriptionsEnded,
            execution_scopes_ended: report.scopesEnded,
            reservations_released: report.reservationsReleased,
            system_notices_owed: report.noticesOwed,
          },
        });
      } catch (err) {
        log(`[end-of-service] audit for '${agent.slug}' failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      log(
        `[end-of-service] '${agent.slug}' (${archetype}): ${REASON_TEXT[reason]}; processes ${report.processOutcome} (${String(report.processes.length)}), subscriptions ended ${String(subscriptionsEnded.length)}, execution scopes ended ${String(scopesEnded)}, reservations released ${String(reservationsReleased.length)}`,
      );
      return report;
    },
  };
}
