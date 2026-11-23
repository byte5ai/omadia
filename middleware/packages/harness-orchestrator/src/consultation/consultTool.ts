/**
 * Spec 2042 §5.4 / ADR-0018 — the harness tool `consult(agent, request)`.
 *
 * Agent A asks a colleague B. The tool only carries the call to the kernel's
 * consultation broker (the {@link ConsultationPort}); every decision — the
 * grant, both switches, the channel scope, depth, budgets, the audience
 * floor, B's envelope, the two views, discretion — is the broker's and is
 * re-checked on every call (a revoked grant is refused on the next call).
 *
 * What reaches A's model is the masked model view: this tool runs as a domain
 * tool, so A's privacy shield interns the returned text exactly as it interns
 * any sub-agent narration. What reaches the user is B's contribution, kept on
 * the turn and delivered by the harness, attributed to B. A refers to it only
 * by its id.
 */

import type { Contribution } from '@omadia/plugin-api';
import type { TurnOrigin } from '@omadia/channel-sdk';

import { turnContext } from '../turnContext.js';
import type { DomainTool } from '../tools/domainQueryTool.js';
import { addTurnLabels, currentDiscretion, resolvedTurnLabels } from '../discretion/turnLabels.js';
import { UNKNOWN_READERS, type LabelSet, type Readers } from '../discretion/labels.js';
import { isConsultationRunOf } from './consultationScope.js';

export const CONSULT_TOOL_NAME = 'consult';

/** A colleague A may consult (for the tool description). */
export interface ConsultTarget {
  readonly slug: string;
  readonly displayName: string;
  readonly description?: string;
}

export interface ConsultRequest {
  readonly fromAgentSlug: string;
  readonly fromTurnId: string;
  readonly toAgentSlug: string;
  readonly request: string;
  /**
   * How many consultations of this turn ran or are running before this one
   * (per-turn budget). Reserved synchronously by the tool, so calls the model
   * makes in parallel each see the slots of the others.
   */
  readonly callsThisTurn: number;
  /** 1-based number of this call in the turn; the contribution id is `c<sequence>`. */
  readonly sequence: number;
  /** A's turn: where it runs and for whom. B runs with the same origin. */
  readonly origin?: TurnOrigin;
  readonly userId?: string;
  /** Discretion: what A's turn has read so far, its conversation and readers. */
  readonly labels: LabelSet;
  readonly contextKey?: string;
  readonly readers: Readers;
}

export type ConsultRefusalReason =
  | 'invalid_input'
  | 'unknown_agent'
  | 'not_consultable'
  | 'may_not_consult'
  | 'no_grant'
  | 'channel_not_granted'
  | 'archetype'
  | 'depth'
  | 'turn_budget'
  | 'day_budget'
  | 'no_audience_floor'
  | 'discretion'
  | 'unavailable';

export type ConsultOutcome =
  | { readonly kind: 'refused'; readonly reason: ConsultRefusalReason; readonly message: string }
  | {
      readonly kind: 'answered';
      /** The user view, delivered by the harness. */
      readonly contribution: Contribution;
      /** Labels of B's contribution; they join A's turn label set. */
      readonly labels: LabelSet;
    };

export interface ConsultationPort {
  /** Colleagues `agentSlug` may consult at all (snapshot, for offering the tool). */
  targetsFor(agentSlug: string): readonly ConsultTarget[];
  consult(request: ConsultRequest): Promise<ConsultOutcome>;
}

/** Per-turn consultation state, a mutable box on the turn context. */
export interface ConsultationTurnState {
  readonly origin?: TurnOrigin;
  readonly userId?: string;
  readonly contributions: Contribution[];
  /** Calls that ran or are running (the per-turn budget); a refusal gives its slot back. */
  calls: number;
  /** Calls ever made in the turn; numbers contributions, never reused. */
  sequence: number;
}

export function createConsultationTurnState(opts: {
  readonly origin?: TurnOrigin;
  readonly userId?: string;
}): ConsultationTurnState {
  return {
    ...(opts.origin ? { origin: opts.origin } : {}),
    ...(opts.userId ? { userId: opts.userId } : {}),
    contributions: [],
    calls: 0,
    sequence: 0,
  };
}

const MAX_REQUEST_CHARS = 8_000;

function describe(targets: readonly ConsultTarget[]): string {
  const list = targets
    .map((t) => `- ${t.slug}: ${t.displayName}${t.description ? ` — ${t.description}` : ''}`)
    .join('\n');
  return (
    'Ask a colleague agent for a contribution. The colleague answers as itself; ' +
    'its answer is delivered to the user unchanged and attributed to it. You see ' +
    'a masked copy and refer to it only by its contribution id: never quote, ' +
    'reword or present it as your own. The colleague gets no access you do not ' +
    'have yourself. Colleagues you may consult:\n' +
    list
  );
}

function refusalText(message: string): string {
  return `Error: consultation refused — ${message}`;
}

/** The text A's model gets for a delivered contribution (A's shield masks it). */
export function contributionModelText(contribution: Contribution): string {
  // The header reaches A's model outside the privacy digest: keep the
  // operator-set name on one line and free of the closing bracket.
  const name = contribution.speaker.displayName.replace(/[\r\n\]]+/g, ' ').trim();
  const header =
    contribution.status === 'delivered'
      ? `[contribution ${contribution.id} from ${name}: delivered to the user unchanged. ` +
        'Refer to it by its id; do not repeat or reword it.]'
      : `[contribution ${contribution.id} from ${name}: FAILED, shown to the user as failed.]`;
  return `${header}\n\n${contribution.text}`;
}

const CONTRIBUTION_HEADER = /^(\[contribution c\d+ from [^\n]*\])\n\n/;

/**
 * Spec §5.4 step 4 (owner decision 2026-11-23): A refers to a contribution by
 * its id, so the header — contribution id, colleague name, status: metadata
 * without personal data — reaches A's model outside the privacy digest. Only
 * the body (B's words) passes the shield. Undefined for any other text, which
 * is then interned whole as before.
 */
export function splitContributionModelText(
  text: string,
): { readonly header: string; readonly body: string } | undefined {
  const match = CONTRIBUTION_HEADER.exec(text);
  if (!match?.[1]) return undefined;
  return { header: match[1], body: text.slice(match[0].length) };
}

/**
 * The `consult` tool of agent `agentSlug`. Offered only while the port lists
 * a colleague for it and the agent is not itself answering a consultation.
 */
export function createConsultTool(port: ConsultationPort, agentSlug: string): DomainTool {
  return {
    name: CONSULT_TOOL_NAME,
    domain: 'consultation',
    get spec() {
      return {
        name: CONSULT_TOOL_NAME,
        description: describe(port.targetsFor(agentSlug)),
        input_schema: {
          type: 'object' as const,
          properties: {
            agent: { type: 'string', description: 'The colleague slug from the list.' },
            request: {
              type: 'string',
              description: 'What you ask the colleague, self-contained, in the user\'s language.',
            },
          },
          required: ['agent', 'request'],
        },
      };
    },
    async handle(input: unknown): Promise<string> {
      const fields = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
      const agent = fields['agent'];
      const request = fields['request'];
      if (typeof agent !== 'string' || !agent.trim() || typeof request !== 'string' || !request.trim()) {
        return refusalText('`agent` and `request` must be non-empty strings.');
      }
      if (request.length > MAX_REQUEST_CHARS) {
        return refusalText(`the request is longer than ${String(MAX_REQUEST_CHARS)} characters.`);
      }
      if (isConsultationRunOf(agentSlug)) {
        return refusalText('you are answering a consultation yourself and cannot consult further.');
      }
      const ctx = turnContext.current();
      if (!ctx?.turnId) return refusalText('no turn is active.');
      // Spec §5.4 step 5: a consultation runs only when the audience floor is
      // active for the turn. Checked here and again by the broker.
      if (!ctx.audienceFloor) {
        return refusalText(
          'the audience floor is not active on this instance, so no consultation can run. Tell the user plainly; an administrator can enable it.',
        );
      }
      const state = ctx.consultation;
      // Reserve the slot before the first await: the model may call `consult`
      // several times in one step, and those calls run in parallel.
      const callsThisTurn = state?.calls ?? 0;
      const sequence = (state?.sequence ?? 0) + 1;
      if (state) {
        state.calls += 1;
        state.sequence = sequence;
      }
      const discretion = currentDiscretion();
      const outcome = await port.consult({
        fromAgentSlug: agentSlug,
        fromTurnId: ctx.turnId,
        toAgentSlug: agent.trim(),
        request: request.trim(),
        callsThisTurn,
        sequence,
        ...(state?.origin ? { origin: state.origin } : {}),
        ...(state?.userId ? { userId: state.userId } : {}),
        labels: await resolvedTurnLabels(discretion),
        ...(discretion?.contextKey !== undefined ? { contextKey: discretion.contextKey } : {}),
        readers: discretion ? await discretion.resolveReaders() : UNKNOWN_READERS,
      });
      if (outcome.kind === 'refused') {
        if (state) state.calls -= 1;
        return refusalText(outcome.message);
      }
      state?.contributions.push(outcome.contribution);
      // A now knows what B contributed: its labels join A's turn.
      addTurnLabels(outcome.labels);
      return contributionModelText(outcome.contribution);
    },
  };
}
