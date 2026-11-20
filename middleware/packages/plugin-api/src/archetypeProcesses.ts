// End of service for the processes of an archetype (#2088, spec 2042 §5.10).
//
// An archetype plugin keeps the process state of its archetype's work (for
// the facilitator: facilitations). When an agent of the archetype is
// disabled or deleted, or the plugin itself is about to be uninstalled, the
// kernel ends what that agent was doing BEFORE the change takes effect. The
// kernel cannot do that alone: the processes are the plugin's. So the plugin
// provides this service, and the kernel calls it while the agent is still
// enabled and the plugin still installed, so the plugin can close each
// process properly (for a facilitation: post its own abort report as the
// facilitator, release what it holds).
//
// The kernel does not depend on the plugin keeping its word. Whatever the
// service answers, throws or takes too long for, the kernel then ends every
// message subscription of the agent itself and goes on with the change. A
// plugin without the service simply loses its subscriptions.
//
// Provide it under `archetypeProcessesServiceName(<archetype id>)`. Only the
// plugin that delivers the archetype is asked; the same name provided by
// another plugin is ignored.

/** Why an agent's processes end. */
export type AgentEndOfServiceReason = 'agent_disabled' | 'agent_deleted' | 'archetype_plugin_removed';

/** The service name for the processes of one archetype. */
export function archetypeProcessesServiceName(archetypeId: string): string {
  return `archetypeProcesses:${archetypeId}`;
}

export interface ArchetypeProcessEndRequest {
  agentSlug: string;
  reason: AgentEndOfServiceReason;
}

/** One process that was running for the agent. */
export interface ArchetypeProcessEnded {
  /** The plugin's own id of the process (a facilitation id). */
  processId: string;
  channelType: string;
  /** Channel-native id of the process's home conversation. */
  conversationId: string;
  /**
   * `aborted`: the process is closed with the reason and resumes never.
   * `failed`: the plugin could not close it; say why in `detail`. The kernel
   * still ends the agent's subscriptions, so the process cannot go on.
   */
  outcome: 'aborted' | 'failed';
  /** The plugin told the conversation (its closing message went out). */
  reportPosted?: boolean;
  /** One line for the operator. */
  detail?: string;
}

export interface ArchetypeProcessEndReport {
  ended: readonly ArchetypeProcessEnded[];
}

export interface ArchetypeProcessesService {
  /**
   * End every running process of this agent, for good: a re-enabled agent
   * resumes none of them. Idempotent, and an agent with nothing running
   * answers `{ ended: [] }`. The kernel waits a bounded time for the answer.
   */
  endProcessesOfAgent(request: ArchetypeProcessEndRequest): Promise<ArchetypeProcessEndReport>;
}
