/**
 * Who speaks, and what kind of output reaches a person (spec 2042 §5.5,
 * ADR-0013, INV-3/4/6/7).
 *
 * Every user-visible message carries a {@link Speaker}: the agent the
 * management layer routed the turn to, or `system` for a notice of the
 * management layer itself. The harness stamps it from the routing decision;
 * no model output can set or change it.
 *
 * Every output goes through one emitter and declares its {@link EmissionType}.
 * The type decides the checks before publication:
 *
 * | Type       | Content                                       | Checks                                              |
 * |------------|-----------------------------------------------|-----------------------------------------------------|
 * | `prose`    | model-generated text                          | identity guard: deterministic layer, then model layer |
 * | `template` | a registered template with typed engine values | template id and value types; no model call          |
 * | `data`     | side-channel data (spec §5.13)                | discretion and audience only; never seen by a model |
 * | `system`   | management-layer notice                       | template rules; speaker `system`                    |
 *
 * A path that cannot name its speaker cannot emit.
 */

/** An agent speaking as itself. Stamped from the routing decision. */
export interface AgentSpeaker {
  readonly kind: 'agent';
  /** `agents.id`. */
  readonly agentId: string;
  /** `agents.slug`. */
  readonly slug: string;
  /** The agent's display name (`agent_identities.display_name`, else the slug). */
  readonly displayName: string;
  /** The agent's avatar, when it has one. */
  readonly avatarUrl?: string;
}

/** The management layer. Not an agent: no persona, no name of its own. */
export interface SystemSpeaker {
  readonly kind: 'system';
}

export type Speaker = AgentSpeaker | SystemSpeaker;

/** The one `system` speaker value. */
export const SYSTEM_SPEAKER: SystemSpeaker = Object.freeze({ kind: 'system' });

export function isAgentSpeaker(speaker: Speaker | undefined): speaker is AgentSpeaker {
  return speaker?.kind === 'agent';
}

export function isSystemSpeaker(speaker: Speaker | undefined): speaker is SystemSpeaker {
  return speaker?.kind === 'system';
}

/** The emission types, in the order of the §5.5 table. */
export const EMISSION_TYPES = ['prose', 'template', 'data', 'system'] as const;

export type EmissionType = (typeof EMISSION_TYPES)[number];

/**
 * Why the management layer speaks instead of an agent. Each code is a
 * registered `system` template; streams add codes additively.
 *
 * - `agent_disabled`: the addressed or bound agent is disabled (INV-7, #1880).
 * - `agent_deleted`: the routing target is a tombstone (spec §5.10).
 * - `agent_unknown`: an explicit address names no agent.
 * - `agent_not_available`: the sender or channel is outside the agent's
 *   availability (spec §5.3).
 * - `no_agent`: nothing addressed, no selection, no binding, and the
 *   default-agent table says `off` or has no entry (spec §5.6).
 * - `agent_selected`: confirms a stored selection (spec §5.3).
 * - `agent_selection_cleared`: the sender's selection was removed.
 * - `agent_directory`: the agents available to the sender here (`/agents`).
 * - `agent_error`: the agent's turn failed.
 * - `missing_grant`: the turn needs a capability the agent does not hold.
 * - `quota_exceeded`: a budget or quota stops the turn.
 * - `identity_guard_blocked`: the identity guard refused the agent's text.
 * - `identity_guard_unavailable`: the guard could not decide (error or
 *   timeout); fail-closed, the text stays unpublished.
 * - `archetype_plugin_removed`: the plugin that delivers the agent's
 *   archetype was uninstalled; the agent is disabled and its running
 *   processes ended without their closing documents (spec §5.10). Posted
 *   once in each affected home conversation.
 * - `model_unavailable`: the agent's model policy pins a primary whose
 *   provider cannot be used now (no key, removed) and allows no fallback
 *   (`fallback: 'none'`), so the turn fails instead of silently running on
 *   another provider (#1877).
 */
export const SYSTEM_NOTICE_CODES = [
  'agent_disabled',
  'agent_deleted',
  'agent_unknown',
  'agent_not_available',
  'no_agent',
  'agent_selected',
  'agent_selection_cleared',
  'agent_directory',
  'agent_error',
  'missing_grant',
  'quota_exceeded',
  'identity_guard_blocked',
  'identity_guard_unavailable',
  // Spec 2042 §5.3 — `/agent` sent to an agent's own bot: that bot is always
  // this agent, there is nothing to select.
  'agent_own_bot',
  // Spec 2042 §5.10 — end of service after the archetype plugin was removed.
  'archetype_plugin_removed',
  // #1877 — the pinned primary is unavailable and the policy allows no fallback.
  'model_unavailable',
] as const;

export type SystemNoticeCode = (typeof SYSTEM_NOTICE_CODES)[number];

/** The agent a notice names (INV-7: the notice names the agent). */
export interface NoticeAgentRef {
  readonly slug: string;
  readonly displayName: string;
  /** Absent for an address that names no agent (`agent_unknown`). */
  readonly agentId?: string;
}

/** A management-layer notice. Its speaker is always `system`. */
export interface SystemNotice {
  readonly code: SystemNoticeCode;
  /** The agent the notice is about, when it is about one. */
  readonly agent?: NoticeAgentRef;
  /** The rendered, localized plain text. Channels render this. */
  readonly text: string;
  /** The locale `text` was rendered in (`de`, `en`). */
  readonly locale: string;
}

/**
 * A colleague's delivered contribution (spec §5.4, ADR-0018): the verbatim,
 * attributed block of a consulted agent. The harness delivers it from that
 * agent's own output; the consulting agent cannot remove or reword it and
 * refers to it only by `id`. Replaces the singular `delegatedAnswer`.
 */
export interface Contribution {
  /** Unique within the answer; two consultations of one agent get two ids. */
  readonly id: string;
  /** The consulted agent. Never `system`. */
  readonly speaker: AgentSpeaker;
  /** The user view of the contribution, or a faithful failure line. */
  readonly text: string;
  /** `failed`: the consultation or its delivery failed; shown as failed, never dropped. */
  readonly status: ContributionStatus;
}

export type ContributionStatus = 'delivered' | 'failed';

/** A typed value a template is filled with. */
export type TemplateValue = string | number | boolean;

/** A side-channel data payload (spec §5.13). Never seen by a model. */
export interface TableData {
  readonly kind: 'table';
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | number | boolean | null)[])[];
  readonly caption?: string;
}

export type DataPayload = TableData;

export interface ProseEmission {
  readonly type: 'prose';
  readonly speaker: AgentSpeaker;
  readonly text: string;
  /**
   * Values the privacy shield restored into `text` server-side (the model
   * never saw them). The identity guard's model layer sees them masked.
   */
  readonly restoredValues?: readonly string[];
}

export interface TemplateEmission {
  readonly type: 'template';
  readonly speaker: AgentSpeaker;
  /** A registered template id. */
  readonly templateId: string;
  readonly values: Readonly<Record<string, TemplateValue>>;
}

export interface DataEmission {
  readonly type: 'data';
  readonly speaker: AgentSpeaker;
  readonly data: DataPayload;
}

export interface SystemEmission {
  readonly type: 'system';
  readonly speaker: SystemSpeaker;
  readonly notice: SystemNotice;
}

export type Emission = ProseEmission | TemplateEmission | DataEmission | SystemEmission;

/** Why an emission was not published. */
export type EmissionRefusalReason =
  | 'identity_guard_blocked'
  | 'identity_guard_unavailable'
  | 'template_unknown'
  | 'template_values_invalid'
  | 'speaker_missing';

export type EmitOutcome =
  | { readonly published: true; readonly emission: Emission }
  | {
      readonly published: false;
      readonly reason: EmissionRefusalReason;
      /** The honest `system` notice published instead. */
      readonly replacement: SystemEmission;
    };

/**
 * The single emitter. Kernel-owned; every user-visible output passes it.
 * Plugins never emit to people themselves: capability results go to the
 * calling agent as data, archetype plugins post through the kernel's send
 * services, which emit on the agent's behalf.
 */
export interface AnswerEmitter {
  emit(emission: Emission): Promise<EmitOutcome>;
}
