import { useEffect, useState } from 'react';

import { agentAvatarImageUrl } from './agentIdentity';
import {
  archetypeOfAgent,
  listEnabledAgents,
  type EnabledAgentDto,
} from './agents';

/**
 * #2057 — the agents a person may pick and see in the directory.
 *
 * Spec 2042 §5.3 / criterion 40: a user is shown only the agents available to
 * them in the channel they are in (availability = which users, in which
 * channels, set by the operator). The picker and the directory both read this
 * one list through {@link useAvailableAgents}, so there is exactly one place
 * to change when the availability endpoint of stream S1 (#2045) lands:
 * {@link fetchAvailableAgents}.
 *
 * TODAY there is no such endpoint. `fetchAvailableAgents` passes the list of
 * enabled agents through unfiltered; the channel is accepted and ignored. See
 * the comment on it for the response shape this module expects.
 */

/** One agent as the picker and the directory show it. */
export interface AgentDirectoryEntry {
  slug: string;
  /** `display_name`, else the registry name, else the slug — never empty. */
  name: string;
  /** Ready-to-use image URL, or `null` (the UI shows initials). */
  avatarUrl: string | null;
  shortDescription: string | null;
  /** `standard`, or the id of an archetype an archetype plugin delivers. */
  archetype: string;
  /** Names of the systems the agent can reach; `null` = not reported. */
  reach: readonly string[] | null;
  /** The default agent of the instance (answers what nobody addressed). */
  isDefault: boolean;
}

export interface AvailableAgents {
  agents: readonly AgentDirectoryEntry[];
  /** Slug of the default agent when it is among `agents`, else `null`. */
  defaultSlug: string | null;
}

/** Which person-and-channel context the list is for. Reserved for S1. */
export interface AvailabilityScope {
  /** Channel key (`web`, `teams`, …). Ignored until the endpoint exists. */
  channel?: string;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function toDirectoryEntry(dto: EnabledAgentDto): AgentDirectoryEntry {
  return {
    slug: dto.slug,
    name: nonEmpty(dto.display_name) ?? nonEmpty(dto.name) ?? dto.slug,
    avatarUrl: agentAvatarImageUrl(dto.avatar),
    shortDescription: nonEmpty(dto.short_description) ?? nonEmpty(dto.description),
    archetype: archetypeOfAgent(dto),
    reach: dto.reach ?? null,
    isDefault: false,
  };
}

/**
 * The agents available to the caller in `scope.channel`.
 *
 * EXPECTED ENDPOINT (stream S1, not built yet): a route that answers for the
 * signed-in user and the given channel and returns the existing
 * `EnabledAgentsListDto` shape, already filtered by availability:
 *
 *   GET /v1/agents/available?channel=<channelKey>
 *   { agents: EnabledAgentDto[], fallback_slug: string | null }
 *
 * with `display_name`, `short_description`, `avatar` and `reach` filled in
 * (all optional here). The filtering happens on the server; this client never
 * decides who may see which agent. Swap the call below, nothing else changes.
 */
export async function fetchAvailableAgents(
  scope: AvailabilityScope = {},
): Promise<AvailableAgents> {
  void scope;
  const list = await listEnabledAgents();
  return {
    agents: list.agents.map(toDirectoryEntry),
    defaultSlug: list.default_slug,
  };
}

export interface AvailableAgentsState {
  loading: boolean;
  error: string | null;
  agents: readonly AgentDirectoryEntry[];
  defaultSlug: string | null;
}

const LOADING: AvailableAgentsState = {
  loading: true,
  error: null,
  agents: [],
  defaultSlug: null,
};

/**
 * Loads the available agents once. Pass `provided` to render a list the caller
 * already has (and skip the request) — this is the `availableAgents` seam.
 */
export function useAvailableAgents(
  provided?: AvailableAgents,
  scope?: AvailabilityScope,
): AvailableAgentsState {
  const [state, setState] = useState<AvailableAgentsState>(LOADING);
  const channel = scope?.channel;

  useEffect(() => {
    if (provided) return;
    let cancelled = false;
    fetchAvailableAgents(channel === undefined ? {} : { channel })
      .then((data) => {
        if (cancelled) return;
        setState({ loading: false, error: null, ...data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          loading: false,
          error: err instanceof Error ? err.message : String(err),
          agents: [],
          defaultSlug: null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [provided, channel]);

  if (provided) {
    return { loading: false, error: null, ...provided };
  }
  return state;
}
