/**
 * #2090 (spec 2043 §0) — execution authorization for archetype plugins.
 *
 * An archetype plugin runs its own scheduler. The kernel bounds every action
 * of it: a model turn, a post, a direct message, a card update, a check, a
 * delivery. Each action needs an AUTHORIZATION, and an authorization is drawn
 * from an EXECUTION SCOPE: a permission of one agent for one process (a
 * facilitation) with a deadline, a budget and the targets it may address.
 *
 * The kernel provides this service under
 * {@link EXECUTION_AUTHORIZATION_SERVICE_NAME}; a plugin lists
 * `executionAuthorization@^1` under `optional_requires`. Only the plugin that
 * delivers the agent's archetype is answered.
 *
 * WHAT THE KERNEL ENFORCES
 *  - the scope belongs to the calling plugin and to an enabled agent of its
 *    archetype;
 *  - the scope state machine: `configuring` first (it takes the home
 *    conversation's reservation); `active` only out of `configuring`, ending
 *    it in the same transaction; a (process, kind, event) exists once, ever,
 *    so an ended scope never re-opens;
 *  - deadline and absolute limit, per kind;
 *  - two budgets, reserved atomically: ACTIONS (each authorization is one)
 *    and MODEL CALLS (every model call of a turn, helper and guard calls
 *    included). Counters are durable;
 *  - the kill switch (instance, agent, process);
 *  - the target of an action is one the scope lists; a conversation target is
 *    one this process holds or held the reservation of.
 *
 * WHAT IT DOES NOT KNOW
 * The lifecycle, the participants, who was confirmed by the group. The plugin
 * states the phase (it must fit the scope's kind) and registers the people a
 * scope may address; the kernel enforces that list and records it.
 */

import type { EmissionType } from './speaker.js';

export const EXECUTION_AUTHORIZATION_SERVICE_NAME = 'executionAuthorization';

/** The five scopes of spec 2043 §0. */
export type ExecutionScopeKind =
  | 'configuring'
  | 'active'
  | 'closing'
  | 'scheduling'
  | 'follow_up';

export const EXECUTION_SCOPE_KINDS: readonly ExecutionScopeKind[] = [
  'configuring',
  'active',
  'closing',
  'scheduling',
  'follow_up',
];

/** The lifecycle phase the plugin states with an action. */
export type ExecutionPhase =
  | 'configuring'
  | 'active'
  | 'concluding'
  | 'closed'
  | 'aborted'
  | 'following_up'
  | 'ended';

/** Which phases an action under a scope of a kind may state. A session
 *  closes, and a meeting is agreed, while the facilitation is still active. */
export const EXECUTION_SCOPE_PHASES: Readonly<Record<ExecutionScopeKind, readonly ExecutionPhase[]>> = {
  configuring: ['configuring'],
  active: ['active'],
  closing: ['active', 'concluding', 'closed', 'aborted', 'following_up'],
  scheduling: ['active', 'concluding', 'closed', 'following_up'],
  follow_up: ['following_up'],
};

/** The emission type of an action. */
export type ExecutionActionType =
  | 'model_turn'
  | 'post'
  | 'direct_message'
  | 'card_update'
  | 'check'
  | 'delivery';

/**
 * The emission type of what an action produces (spec 2042 §5.5): `prose` is
 * model-written text, `template` a registered template filled with engine
 * values, `data` side-channel data. Recorded with the authorization.
 */
export type ExecutionEmissionType = Exclude<EmissionType, 'system'>;

/** What the action is for. Past the deadline of an `active` scope in its
 *  deadline wait, only `consent`, `status` and `stop` are authorized; a
 *  `closing` scope authorizes only {@link CLOSING_SCOPE_PURPOSES}. */
export type ExecutionPurpose =
  | 'moderation'
  | 'handshake'
  | 'link'
  | 'reminder'
  | 'status'
  | 'consent'
  | 'stop'
  | 'essential_message'
  | 'protocol_dispatch'
  | 'invitation'
  | 'readiness_check'
  | 'roster_check'
  | 'other';

/**
 * #2090 (spec 2043 §0, §5.2) — what a `closing` scope authorizes: the
 * essential messages of its closing event, their dispatch, the consent
 * answers of a required confirmation, status and stop, and checks. Never
 * moderation: a closing does not re-open it. `other` only for a `check`.
 * Since plugin-api 1.84.0.
 */
export const CLOSING_SCOPE_PURPOSES: readonly ExecutionPurpose[] = [
  'essential_message',
  'protocol_dispatch',
  'consent',
  'status',
  'stop',
  'invitation',
  'readiness_check',
  'roster_check',
  'other',
];

export type ExecutionTarget =
  | { readonly kind: 'conversation'; readonly channelType: string; readonly conversationId: string }
  | {
      readonly kind: 'person';
      readonly channelType: string;
      /** The platform principal, as inbound events state it. */
      readonly principalId: string;
      /** `status_only`: this person may only receive this process's status
       *  (the private status answer of spec 2043 §0). */
      readonly restriction?: 'status_only';
    };

export interface ExecutionBudget {
  /** Authorized actions, model-free ones included. */
  readonly actions: number;
  /** Model calls, helper and guard calls included. */
  readonly modelCalls: number;
}

export interface ExecutionScope {
  readonly id: string;
  readonly agentSlug: string;
  readonly processId: string;
  readonly kind: ExecutionScopeKind;
  /** The closing event or the agreed meeting; `''` for the other kinds. */
  readonly eventId: string;
  readonly state: 'open' | 'ended';
  readonly deadline: string;
  /** The deadline can never be moved past this. */
  readonly absoluteLimit: string;
  readonly deadlineWait: boolean;
  readonly budget: ExecutionBudget;
  readonly used: ExecutionBudget;
  readonly targets: readonly ExecutionTarget[];
  readonly openedAt: string;
  readonly endedAt?: string;
  readonly endReason?: string;
}

export type ExecutionRefusalCode =
  | 'not_permitted'
  | 'unknown_agent'
  | 'unknown_scope'
  | 'invalid_request'
  | 'scope_exists'
  | 'scope_order'
  | 'scope_ended'
  | 'deadline_passed'
  | 'limit_exceeded'
  | 'budget_exhausted'
  | 'kill_switch'
  | 'phase_mismatch'
  | 'purpose_not_allowed'
  | 'target_not_allowed'
  | 'conversation_busy'
  /** #2089 — a session conversation is linked only on a link request made
   *  inside it and bound to this process (spec 2043 §5.3, criterion 48). */
  | 'link_not_authorized'
  /** #2076 — a session goes `live` only where the channel can deliver every
   *  message of its conversation (criterion 60). */
  | 'not_ready'
  /** #2076 — the session-state change is not one of the table's. */
  | 'session_state'
  | 'unavailable';

export interface ExecutionRefusal {
  readonly outcome: 'refused';
  readonly code: ExecutionRefusalCode;
  readonly message: string;
}

export interface OpenExecutionScopeRequest {
  readonly agentSlug: string;
  readonly processId: string;
  readonly kind: ExecutionScopeKind;
  /** Required for `closing` (its closing event) and `scheduling` (the agreed
   *  meeting); several of each may be open, each with its own id. */
  readonly eventId?: string;
  /**
   * `closing` only (plugin-api 1.84.0): when the closing event happened, ISO
   * time. The absolute limit of 30 days counts from it (spec 2043 §0), also
   * when the scope is opened later (a restart, a send that was retried). It
   * may not lie in the future nor before the process's first scope. Absent:
   * the event is now.
   */
  readonly eventAt?: string;
  /** ISO time. Absent for `configuring`: the kernel's configured maximum. */
  readonly deadline?: string;
  readonly budget: ExecutionBudget;
  readonly targets?: readonly ExecutionTarget[];
  /** `configuring` only, required there: the conversation the process was
   *  started in. Its reservation is taken in the same transaction. */
  readonly home?: { readonly channelType: string; readonly conversationId: string };
}

export interface AuthorizeActionRequest {
  readonly scopeId: string;
  readonly phase: ExecutionPhase;
  readonly purpose: ExecutionPurpose;
  readonly action: ExecutionActionType;
  /** Required for `post`, `direct_message`, `card_update` and `delivery`. */
  readonly target?: ExecutionTarget;
  /** What the action produces. A `model_turn` is always `prose`. */
  readonly emission?: ExecutionEmissionType;
  /** Model calls to reserve for a `model_turn`; unused ones are returned by
   *  {@link ExecutionAuthorizationService.settle}. */
  readonly modelCalls?: number;
}

export interface ExecutionAuthorization {
  readonly outcome: 'authorized';
  readonly authorizationId: string;
  readonly scopeId: string;
  readonly remaining: ExecutionBudget;
}

/**
 * #2076 (spec 2043 §5.2, §5.3) — the state of the session a `session`
 * reservation is for. The kernel derives from it what the process reads and
 * where it may send. Of the sending column the kernel enforces the released
 * states (only a `closing` scope) and `confirming` (consent, status, stop and
 * essential/protocol messages); in `scheduled` and `live` the plugin keeps
 * to the column:
 *
 * | state        | delivered and read                  | the process may send |
 * |--------------|-------------------------------------|----------------------|
 * | `scheduled`  | messages addressed to the agent     | link confirmation, agenda, preparation |
 * | `live`       | every human message                 | moderation |
 * | `confirming` | every human message                 | consent request, status |
 * | `closed`     | nothing; the reservation is released | only under a `closing` scope |
 * | `cancelled`  | nothing; the reservation is released | only under a `closing` scope |
 */
export type SessionConversationState = 'scheduled' | 'live' | 'confirming' | 'closed' | 'cancelled';

/** The transitions the kernel accepts. */
export const SESSION_CONVERSATION_TRANSITIONS: Readonly<Record<SessionConversationState, readonly SessionConversationState[]>> = {
  scheduled: ['live', 'cancelled'],
  live: ['confirming', 'closed'],
  confirming: ['closed'],
  closed: [],
  cancelled: [],
};

export interface ConversationReservation {
  readonly channelType: string;
  readonly conversationId: string;
  readonly processId: string;
  readonly role: 'home' | 'session';
  readonly reservedAt: string;
  readonly releasedAt?: string;
  /** `session` role: the session's state (plugin-api 1.81.0). */
  readonly sessionState?: SessionConversationState;
  /** `session` role: the plugin's id of the session. */
  readonly sessionId?: string;
}

export interface ExecutionAuthorizationService {
  /** Open a scope. `configuring` also takes the home reservation; `active`
   *  ends the process's `configuring` scope in the same transaction. */
  openScope(
    request: OpenExecutionScopeRequest,
  ): Promise<{ outcome: 'opened'; scope: ExecutionScope } | ExecutionRefusal>;
  /** Reserve one action (and model calls) from the scope, atomically. */
  authorize(request: AuthorizeActionRequest): Promise<ExecutionAuthorization | ExecutionRefusal>;
  /** Report the model calls a turn really made; the rest of its reservation
   *  goes back to the scope. Idempotent. */
  settle(authorizationId: string, used: { modelCalls: number }): Promise<void>;
  /** Replace the people a scope may address. Conversation targets are kept. */
  setPeople(
    scopeId: string,
    people: readonly Extract<ExecutionTarget, { kind: 'person' }>[],
  ): Promise<{ outcome: 'updated'; scope: ExecutionScope } | ExecutionRefusal>;
  /** Move the deadline, within the kind's absolute limit. `deadlineWait`
   *  (`active` only) is the bounded wait past the agreed deadline (spec 2043
   *  §5.6): since plugin-api 1.84.0 it needs an open `closing` scope of the
   *  same process (the session closings it waits for are opened first) and
   *  never runs past the latest absolute limit of those (`scope_order`,
   *  `limit_exceeded`). */
  extendScope(
    scopeId: string,
    change: { deadline: string; deadlineWait?: boolean },
  ): Promise<{ outcome: 'extended'; scope: ExecutionScope } | ExecutionRefusal>;
  /** End a scope. Idempotent; an ended scope never re-opens. */
  endScope(scopeId: string, reason: string): Promise<void>;
  /** The scopes of one of the caller's processes, open and ended. */
  listScopes(processId: string): Promise<readonly ExecutionScope[]>;
  /** Take a further conversation for the process (a linked session
   *  conversation). Refused with `conversation_busy` when another process or
   *  an agent discussion holds it.
   *
   *  Since plugin-api 1.81.0 (#2089, spec 2043 §5.3) the link must be
   *  authorized from inside the conversation: `linkRequestId` names a link
   *  request (`conversationMessages@2.onLinkRequest`) made in exactly this
   *  conversation and offered for this process; it is consumed in the same
   *  transaction. Without one, or with one that does not fit, the answer is
   *  `link_not_authorized` and nothing is taken. The reservation starts in
   *  session state `scheduled`, and the conversation is added to the
   *  targets of the process's open `configuring` and `active` scopes.
   *  Asked again by the process that holds it: the same reservation. A
   *  process that lost its own HOME conversation's reservation takes it back
   *  without a link request, unless an operator released it. */
  reserveConversation(request: {
    agentSlug: string;
    processId: string;
    channelType: string;
    conversationId: string;
    linkRequestId?: string;
    /** The plugin's id of the session the conversation is linked for. */
    sessionId?: string;
  }): Promise<{ outcome: 'reserved'; reservation: ConversationReservation } | ExecutionRefusal>;
  /**
   * #2076 (spec 2043 §5.2, §5.3) — move a linked session conversation to
   * another session state; the kernel applies the read table at once (the
   * process's message subscription there follows). Only the transitions of
   * {@link SESSION_CONVERSATION_TRANSITIONS}; the same state again is
   * accepted (idempotent). `live` needs the channel's readiness to deliver
   * every message there (`not_ready` with what is missing otherwise; the
   * state stays). `closed` and `cancelled` release the reservation in the
   * same transaction. Optional: absent on a kernel before plugin-api 1.81.0.
   */
  setSessionState?(request: {
    processId: string;
    channelType: string;
    conversationId: string;
    state: SessionConversationState;
    reason?: string;
  }): Promise<{ outcome: 'updated'; reservation: ConversationReservation } | ExecutionRefusal>;
  /** Release one of the process's reservations. Idempotent. */
  releaseConversation(request: {
    processId: string;
    channelType: string;
    conversationId: string;
    reason: string;
  }): Promise<void>;
  listReservations(processId: string): Promise<readonly ConversationReservation[]>;
}
