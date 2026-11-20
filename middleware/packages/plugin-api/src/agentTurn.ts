// Kernel-run agent turn ('agentTurn@1', #2043): an engine plugin asks the
// kernel to run ONE turn as a named agent for a stored inbound event and gets
// the text back without it being posted. The plugin decides what to send and
// sends it through its own outbox.
//
// The turn runs inside the agent's normal envelope: its identity prompt
// (including the neutrality block for facilitators), model policy, privacy
// shield and receipts all apply. Kernel-published, optional.

import type {
  ExecutionPhase,
  ExecutionPurpose,
  ExecutionRefusalCode,
  ExecutionTarget,
} from './executionAuthorization.js';

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
  /** @deprecated the previous name of {@link archetype}; removed together
   *  with the `agents.kind` column. */
  kind: 'standard' | 'facilitator';
  /** The agent's archetype (`agents.archetype`, #2088): `standard`, or one
   *  an archetype plugin registered. Absent on a kernel older than 1.58.0:
   *  read {@link kind}. */
  archetype?: string;
  /** The name the agent wears (its identity's display name, else its label). */
  displayName: string;
  shortDescription?: string;
  /** BCP 47 language the instance answers in, when the operator set one. */
  language?: string;
  /** Channel types the agent has an identity of its own on. */
  ownIdentityChannelTypes: readonly string[];
  /**
   * #2066 — the settings the operator gave this agent, for the fields its
   * archetype declares (`archetype.agent_settings` in the archetype plugin's
   * manifest): a string for an `enum` field, a list of numbers for a
   * `number_list` field. Only fields that are set appear; a missing key means
   * the plugin's own instance setting applies. Absent on a kernel older than
   * 1.79.0, and when nothing is set.
   */
  archetypeSettings?: Readonly<Record<string, string | readonly number[]>>;
}

export interface AgentTurnService {
  runTurn(request: AgentTurnRequest): Promise<AgentTurnOutcome>;
  /** The profile of an agent bound to the calling engine; `undefined` for
   *  any other agent. Optional — feature-detect on older kernels. */
  getProfile?(agentSlug: string): Promise<AgentProfile | undefined>;
}

// ---------------------------------------------------------------------------
// agentTurn@2 (#2090) — a turn under an execution scope
// ---------------------------------------------------------------------------

/**
 * The second major of the turn service: `ctx.services.get('agentTurn@2')`,
 * declared as `agentTurn@^2` under `optional_requires`.
 *
 * It runs the same turn as the first major, with the same guards. What it
 * adds: the turn is an authorized action. The request names the execution
 * scope it runs under, the process, the phase, the purpose and how many model
 * calls it reserves; the kernel draws the authorization from the scope before
 * any model is called and refuses the turn otherwise (past the deadline,
 * without budget, with the kill switch on, in a phase that does not fit).
 * After the turn the kernel counts the model calls it made, helper and guard
 * calls included, and returns the unused part of the reservation.
 *
 * The reservation is a hard cap: a model call of the turn that the
 * reservation does not cover is not made, whoever in the turn asked for it
 * (the main model, a helper, a guard). The turn then ends `refused` with
 * `reservation_exceeded` and returns no text, also when the refused call was
 * a helper that would have carried on without it. What the turn did use is
 * charged to the scope.
 */
export const AGENT_TURN_V2_SERVICE_NAME = 'agentTurn@2';

export interface ScopedAgentTurnRequest extends AgentTurnRequest {
  /** The execution scope the turn is drawn from. */
  readonly scopeId: string;
  /** The process the scope belongs to; must be the scope's own. */
  readonly processId: string;
  readonly phase: ExecutionPhase;
  readonly purpose: ExecutionPurpose;
  /** A model turn produces prose. Stated, so every action names its type. */
  readonly emission: 'prose';
  /** Model calls reserved for this turn, helper and guard calls included. */
  readonly budget: { readonly modelCalls: number };
  /** Where the text is meant to go, if the caller knows; it must be a target
   *  of the scope. The send itself is authorized separately. */
  readonly target?: ExecutionTarget;
}

export type ScopedAgentTurnOutcome =
  | {
      outcome: 'completed';
      text: string;
      turnId?: string;
      authorizationId: string;
      /** Model calls reserved and really made. */
      modelCalls: { reserved: number; used: number };
    }
  | {
      outcome: 'refused';
      code:
        | 'unknown_agent'
        | 'not_bound'
        | 'budget_exceeded'
        | 'unavailable'
        | 'not_authorized'
        | 'reservation_exceeded';
      message: string;
      /** With `not_authorized`: why the execution authorization refused. */
      executionCode?: ExecutionRefusalCode;
      /** With `reservation_exceeded`: the authorization the turn consumed and
       *  the model calls it reserved, made and was refused. */
      authorizationId?: string;
      modelCalls?: { reserved: number; used: number; refused: number };
    }
  | {
      outcome: 'failed';
      message: string;
      /** The authorization the failed turn consumed, if it got that far. */
      authorizationId?: string;
    };

export interface ScopedAgentTurnService {
  runTurn(request: ScopedAgentTurnRequest): Promise<ScopedAgentTurnOutcome>;
  getProfile(agentSlug: string): Promise<AgentProfile | undefined>;
}
