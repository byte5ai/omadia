/**
 * Spec 2042 §5.3, INV-1, criterion 40 — `agentDirectory@1`: the agents a
 * person may address through a channel, and what an unaddressed message from
 * them would reach there. The picker of a UI that lets the user choose an
 * agent per conversation (the canvas channel) is built from it.
 *
 * It is the kernel's own `GET /api/v1/agents/directory` answer, for the asking
 * person — a channel plugin cannot call that session-authenticated route, so
 * the kernel serves the same view as a service, from the same function. The
 * directory never decides whether a turn may run: that is the channel
 * resolver's job, per turn (`resolveAgent`).
 *
 * Given only to plugins of kind `channel`.
 */

/** Service name of the directory (`agentDirectory@1`). */
export const AGENT_DIRECTORY_SERVICE_NAME = 'agentDirectory';

/** Who asks: the person a channel has authenticated. */
export interface AgentDirectoryRequest {
  /** the channel type the availability is read for (`web` for the canvas) */
  readonly channel: string;
  /** the asking channel plugin's catalog id */
  readonly channelId: string;
  readonly tenantId?: string;
  /** the verified subject of the session */
  readonly subject: string;
  readonly email?: string;
  readonly omadiaUserId?: string;
  readonly provider: string;
}

/** One agent as the directory lists it: addressable and available to the asker. */
export interface AgentDirectoryAgent {
  /** `agents.id` — what `resolveAgent` and a turn's `metadata.agentId` take */
  readonly id: string;
  readonly slug: string;
  readonly display_name: string;
  readonly short_description: string | null;
  readonly avatar_url: string | null;
  readonly archetype: string | null;
}

/** What an unaddressed message reaches: the default agent, or why none. */
export type AgentDirectoryDefault =
  | { readonly slug: string }
  | { readonly slug: null; readonly notice: string };

export interface AgentDirectoryView {
  readonly channel: string;
  readonly agents: readonly AgentDirectoryAgent[];
  readonly default_agent: AgentDirectoryDefault;
}

export interface AgentDirectoryService {
  listAvailable(request: AgentDirectoryRequest): Promise<AgentDirectoryView>;
}
