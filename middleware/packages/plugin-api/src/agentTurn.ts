// Kernel-run agent turn ('agentTurn@1', #2043): an engine plugin asks the
// kernel to run ONE turn as a named agent for a stored inbound event and gets
// the text back without it being posted. The plugin decides what to send and
// sends it through its own outbox.
//
// The turn runs inside the agent's normal envelope: its identity prompt
// (including the neutrality block for facilitators), model policy, privacy
// shield and receipts all apply. Kernel-published, optional.

export const AGENT_TURN_SERVICE_NAME = 'agentTurn';

export interface AgentTurnRequest {
  /** The agent to run as. Must be bound to the calling plugin's engine. */
  agentSlug: string;
  /** Stable session key; turns with the same key share history. */
  sessionKey: string;
  channelType: string;
  conversationId: string;
  /** The stored inbound event this turn answers ('conversationMessages@1').
   *  Absent for a turn the engine starts itself (timer, timebox end). */
  inboundEventId?: string;
  /** The turn's input text. */
  input: string;
  /** Engine state for this turn, appended to the system prompt after the
   *  agent's own identity. It cannot replace or precede the identity. */
  engineContext?: string;
}

export type AgentTurnOutcome =
  | { outcome: 'completed'; text: string; turnId?: string }
  | {
      outcome: 'refused';
      code: 'unknown_agent' | 'not_bound' | 'budget_exceeded' | 'unavailable';
      message: string;
    }
  | { outcome: 'failed'; message: string };

/** What an engine may know about the agent it runs (#2043). Per-agent
 *  defaults of the engine live in the engine's own tables. */
export interface AgentProfile {
  agentSlug: string;
  kind: 'standard' | 'facilitator';
  /** The name the agent wears (its identity's display name, else its label). */
  displayName: string;
  shortDescription?: string;
  /** BCP 47 language the instance answers in, when the operator set one. */
  language?: string;
  /** Channel types the agent has an identity of its own on. */
  ownIdentityChannelTypes: readonly string[];
}

export interface AgentTurnService {
  runTurn(request: AgentTurnRequest): Promise<AgentTurnOutcome>;
  /** The profile of an agent bound to the calling engine; `undefined` for
   *  any other agent. Optional — feature-detect on older kernels. */
  getProfile?(agentSlug: string): Promise<AgentProfile | undefined>;
}
