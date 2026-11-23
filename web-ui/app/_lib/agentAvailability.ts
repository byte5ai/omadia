import { callJson } from './agents';

/**
 * Spec 2042 — who may reach an agent. `PUT
 * /api/v1/operator/agents/:slug/availability`; `GET /api/v1/operator/agents`
 * returns it per agent.
 *
 *  - `everyone`: every person may reach the agent. A new agent starts with
 *    `false`, so an agent nobody was given reaches nobody;
 *  - `channels`: the channels it answers in; `null` = every channel;
 *  - `principals`: who may reach it besides `everyone` — `user:<id>` or
 *    `role:<name>` entries.
 */
export interface AgentAvailability {
  everyone: boolean;
  channels: string[] | null;
  principals: string[];
}

/** What a new agent starts with: nobody. */
export const NEW_AGENT_AVAILABILITY: AgentAvailability = {
  everyone: false,
  channels: null,
  principals: [],
};

const PRINCIPAL_PATTERN = /^(user|role):\S.*$/;

/** A `user:…` or `role:…` reference. */
export function isPrincipal(raw: string): boolean {
  return PRINCIPAL_PATTERN.test(raw.trim());
}

/** Does this availability let anybody reach the agent? */
export function reachesAnybody(a: AgentAvailability): boolean {
  return (a.everyone || a.principals.length > 0) && (a.channels === null || a.channels.length > 0);
}

export async function setAgentAvailability(
  slug: string,
  availability: AgentAvailability,
): Promise<void> {
  await callJson<unknown>(`/v1/operator/agents/${encodeURIComponent(slug)}/availability`, {
    method: 'PUT',
    body: JSON.stringify(availability),
  });
}
