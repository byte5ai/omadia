/**
 * A `system` notice the kernel owes a conversation outside an inbound turn
 * (spec 2042 INV-7, §5.10): when an agent's service ends (disabled, deleted,
 * archetype plugin removed), each affected home conversation is told. Never
 * attributed to an agent. Inbound turns get their notice from routing
 * directly (`ResolveResult.notice`).
 */
export interface SystemNoticeRequest {
  readonly kind: 'agent_deleted' | 'agent_disabled' | 'archetype_plugin_removed';
  readonly channelType: string;
  /** The conversation (channel key or channel-native conversation id). */
  readonly channelKey: string;
  readonly agentId: string;
  /** The name the agent wore, for the sentence. */
  readonly agentName: string;
  /** The agent's slug, for the notice's agent reference. */
  readonly agentSlug?: string;
  /** What ended with it, when something did (a process id of its archetype). */
  readonly processId?: string;
}
