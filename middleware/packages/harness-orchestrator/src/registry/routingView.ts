/**
 * #2055 — the management layer's view of one config snapshot: every live
 * agent with its status and availability, the tombstones, provisioned
 * identities, bindings, selections and default-agent entries. Built once per
 * snapshot; routing reads it synchronously.
 */

import type { RoutingAgentRecord, RoutingView } from '../routing/managementRouter.js';

import { archetypeOmits } from './archetype.js';
import type { AgentRow, ConfigSnapshot } from './configStore.js';
import type { DefaultAgentEntryRow } from './routingTables.js';
import type { AgentTombstone } from './tombstones.js';

function key(...parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function liveRecord(agent: AgentRow, principals: readonly string[]): RoutingAgentRecord {
  return {
    id: agent.id,
    slug: agent.slug,
    displayName: agent.identityName?.trim() || agent.name,
    status: agent.status,
    deleted: false,
    availableToEveryone: agent.availableToEveryone === true,
    availableChannels: agent.availableChannels ?? null,
    availablePrincipals: principals,
    bindable: !archetypeOmits(agent, 'channel_binding'),
    defaultable: !archetypeOmits(agent, 'default_agent'),
  };
}

function tombstoneRecord(tombstone: AgentTombstone): RoutingAgentRecord {
  return {
    id: tombstone.id,
    slug: tombstone.slug,
    displayName: tombstone.name,
    status: 'deleted',
    deleted: true,
    availableToEveryone: false,
    availableChannels: null,
    availablePrincipals: [],
    bindable: false,
    defaultable: false,
  };
}

export class SnapshotRoutingView implements RoutingView {
  private readonly byId = new Map<string, RoutingAgentRecord>();
  private readonly liveBySlug = new Map<string, RoutingAgentRecord>();
  private readonly deletedBySlug = new Map<string, RoutingAgentRecord>();
  private readonly identities = new Map<string, string>();
  private readonly bindings = new Map<string, string>();
  private readonly selections = new Map<string, string>();
  private readonly entries: readonly DefaultAgentEntryRow[];

  constructor(snapshot: ConfigSnapshot | undefined) {
    const principalsByAgent = new Map<string, string[]>();
    for (const row of snapshot?.availabilityPrincipals ?? []) {
      principalsByAgent.set(row.agentId, [...(principalsByAgent.get(row.agentId) ?? []), row.principal]);
    }
    for (const agent of snapshot?.agents ?? []) {
      const record = liveRecord(agent, principalsByAgent.get(agent.id) ?? []);
      this.byId.set(agent.id, record);
      this.liveBySlug.set(agent.slug, record);
    }
    for (const tombstone of snapshot?.tombstones ?? []) {
      const record = tombstoneRecord(tombstone);
      this.byId.set(tombstone.id, record);
      if (!this.deletedBySlug.has(tombstone.slug)) this.deletedBySlug.set(tombstone.slug, record);
    }
    for (const identity of snapshot?.channelIdentities ?? []) {
      this.identities.set(key(identity.channelType, identity.channelKey), identity.agentId);
    }
    for (const binding of snapshot?.channelBindings ?? []) {
      this.bindings.set(key(binding.channelType, binding.channelKey), binding.agentId);
    }
    for (const selection of snapshot?.selections ?? []) {
      this.selections.set(
        key(selection.channelType, selection.conversationKey, selection.principal),
        selection.agentId,
      );
    }
    this.entries = snapshot?.defaultEntries ?? [];
  }

  agentById(id: string): RoutingAgentRecord | undefined {
    return this.byId.get(id);
  }

  agentBySlug(slug: string): RoutingAgentRecord | undefined {
    return this.liveBySlug.get(slug) ?? this.deletedBySlug.get(slug);
  }

  identityOwner(channelType: string, channelKey: string): string | undefined {
    return this.identities.get(key(channelType, channelKey));
  }

  bindingOwner(channelType: string, channelKey: string): string | undefined {
    return this.bindings.get(key(channelType, channelKey));
  }

  selectionOwner(channelType: string, conversationKey: string, principal: string): string | undefined {
    return this.selections.get(key(channelType, conversationKey, principal));
  }

  defaultEntries(): readonly DefaultAgentEntryRow[] {
    return this.entries;
  }

  /** Every live agent, for directories and pickers. */
  liveAgents(): readonly RoutingAgentRecord[] {
    return [...this.liveBySlug.values()];
  }
}
