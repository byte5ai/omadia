/**
 * #2045 — the speaker of an agent, stamped from routing (spec 2042 INV-4):
 * its id, slug, the name it wears and, when it has one, its avatar.
 */

import type { AgentSpeaker } from '@omadia/plugin-api';

import type { AgentRow } from '../registry/configStore.js';

/** The same-origin path the operator API serves an agent's avatar under. */
export function agentAvatarUrl(slug: string, etag: string): string {
  return `/api/v1/operator/agents/${encodeURIComponent(slug)}/identity/avatar?v=${encodeURIComponent(etag)}`;
}

export function speakerFor(
  agent: Pick<AgentRow, 'id' | 'slug' | 'name' | 'identityName' | 'avatarEtag'>,
): AgentSpeaker {
  return {
    kind: 'agent',
    agentId: agent.id,
    slug: agent.slug,
    displayName: agent.identityName?.trim() || agent.name,
    ...(agent.avatarEtag ? { avatarUrl: agentAvatarUrl(agent.slug, agent.avatarEtag) } : {}),
  };
}
