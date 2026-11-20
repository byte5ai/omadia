/**
 * #2055 — the management layer carries out `/agent <name>`, `/agent` and
 * `/agents` (spec 2042 §5.3): it stores the sender's selection for this
 * conversation and answers with a `system` notice. Deterministic, no model.
 *
 * Only agents available to the sender in this channel can be selected or are
 * listed; an agent reached only through its own identity (a facilitator) is
 * neither.
 */

import type {
  AgentCommand,
  AgentSelectionContext,
  AgentSelectionService,
} from '@omadia/channel-sdk';
import type { SystemNotice } from '@omadia/plugin-api';

import type { OrchestratorRegistry } from '../registry/index.js';
import type { RoutingTables } from '../registry/routingTables.js';
import {
  ADDRESSABLE_STATUS,
  ManagementRouter,
  type RoleMembership,
  type RoutingAgentRecord,
} from '../routing/managementRouter.js';

import { buildSystemNotice } from './systemNotices.js';

export interface AgentSelectionDeps {
  readonly registry: Pick<OrchestratorRegistry, 'routingView' | 'adoptSelection' | 'forgetSelection'>;
  readonly tables: Pick<RoutingTables, 'setSelection' | 'clearSelection'>;
  readonly hasRole?: RoleMembership;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function matches(agent: RoutingAgentRecord, name: string): boolean {
  const wanted = normalize(name);
  return normalize(agent.displayName) === wanted || normalize(agent.slug) === wanted;
}

function ref(agent: RoutingAgentRecord): NonNullable<SystemNotice['agent']> {
  return { slug: agent.slug, displayName: agent.displayName, agentId: agent.id };
}

export class KernelAgentSelectionService implements AgentSelectionService {
  constructor(private readonly deps: AgentSelectionDeps) {}

  /** The agents the sender may choose in this channel, by display name. */
  selectable(context: Pick<AgentSelectionContext, 'channelType' | 'principal'>): RoutingAgentRecord[] {
    const view = this.deps.registry.routingView();
    const router = new ManagementRouter({ view, ...(this.deps.hasRole ? { hasRole: this.deps.hasRole } : {}) });
    return view
      .liveAgents()
      .filter((a) => a.status === ADDRESSABLE_STATUS && a.bindable && router.isAvailable(a, context))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async handle(command: AgentCommand, context: AgentSelectionContext): Promise<SystemNotice> {
    const locale = context.locale;
    const notice = (code: SystemNotice['code'], extra: Parameters<typeof buildSystemNotice>[1] = {}): SystemNotice =>
      buildSystemNotice(code, { ...extra, ...(locale ? { locale } : {}) });

    if (command.kind === 'list') {
      return notice('agent_directory', { items: this.selectable(context).map((a) => a.displayName) });
    }
    if (command.kind === 'clear') {
      await this.deps.tables.clearSelection(context.channelType, context.conversationKey, context.principal);
      this.deps.registry.forgetSelection(context.channelType, context.conversationKey, context.principal);
      return notice('agent_selection_cleared');
    }

    // A slug is unique; a display name may not be: an exact slug wins.
    const selectable = this.selectable(context);
    const chosen =
      selectable.find((a) => normalize(a.slug) === normalize(command.name)) ??
      selectable.find((a) => matches(a, command.name));
    if (!chosen) {
      const known = this.deps.registry.routingView().liveAgents().find((a) => matches(a, command.name));
      if (!known) {
        return notice('agent_unknown', { agent: { slug: command.name, displayName: command.name } });
      }
      return notice(known.status === ADDRESSABLE_STATUS ? 'agent_not_available' : 'agent_disabled', {
        agent: ref(known),
      });
    }
    const row = await this.deps.tables.setSelection({
      channelType: context.channelType,
      conversationKey: context.conversationKey,
      principal: context.principal,
      agentId: chosen.id,
    });
    this.deps.registry.adoptSelection(row);
    return notice('agent_selected', { agent: ref(chosen) });
  }
}
