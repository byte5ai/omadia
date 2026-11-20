import { useEffect, useState } from 'react';

import { getAgentDirectory, type AgentDirectoryEntryDto } from './agents';

/**
 * #2057 — the agents a person may pick and see in the directory.
 *
 * Spec 2042 §5.3 / criterion 40: a user is shown only the agents available to
 * them in the channel they are in. The server filters
 * (`GET /api/v1/agents/directory?channel=`); this client never decides who may
 * see which agent. The picker and the directory both read the one list through
 * {@link useAvailableAgents}.
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
  /** Why there is no default agent (the server's `system` notice), else `null`. */
  defaultNotice?: string | null;
}

/** Which channel the list is for. */
export interface AvailabilityScope {
  /** Channel key (`web`, `teams`, …); the web UI asks for `web`. */
  channel?: string;
}

const DEFAULT_DIRECTORY_CHANNEL = 'web';

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** The server hands out API paths (`/api/…`); the browser reaches them via `/bot-api/`. */
function directoryAvatarUrl(url: string | null): string | null {
  const trimmed = nonEmpty(url);
  return trimmed ? trimmed.replace(/^\/api\//, '/bot-api/') : null;
}

export function toDirectoryEntry(
  dto: AgentDirectoryEntryDto,
  defaultSlug: string | null,
): AgentDirectoryEntry {
  return {
    slug: dto.slug,
    name: nonEmpty(dto.display_name) ?? dto.slug,
    avatarUrl: directoryAvatarUrl(dto.avatar_url),
    shortDescription: nonEmpty(dto.short_description),
    archetype: dto.archetype,
    reach: null,
    isDefault: dto.slug === defaultSlug,
  };
}

/** The agents available to the caller in `scope.channel` (default `web`). */
export async function fetchAvailableAgents(
  scope: AvailabilityScope = {},
): Promise<AvailableAgents> {
  const directory = await getAgentDirectory(scope.channel ?? DEFAULT_DIRECTORY_CHANNEL);
  const defaultSlug = directory.default_agent.slug;
  return {
    agents: directory.agents.map((a) => toDirectoryEntry(a, defaultSlug)),
    defaultSlug,
    defaultNotice: 'notice' in directory.default_agent ? directory.default_agent.notice.text : null,
  };
}

export interface AvailableAgentsState {
  loading: boolean;
  error: string | null;
  agents: readonly AgentDirectoryEntry[];
  defaultSlug: string | null;
  defaultNotice: string | null;
}

const LOADING: AvailableAgentsState = {
  loading: true,
  error: null,
  agents: [],
  defaultSlug: null,
  defaultNotice: null,
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
        setState({ loading: false, error: null, ...data, defaultNotice: data.defaultNotice ?? null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          loading: false,
          error: err instanceof Error ? err.message : String(err),
          agents: [],
          defaultSlug: null,
          defaultNotice: null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [provided, channel]);

  if (provided) {
    return { loading: false, error: null, ...provided, defaultNotice: provided.defaultNotice ?? null };
  }
  return state;
}
