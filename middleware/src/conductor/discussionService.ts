// Start an agent topic discussion in a bound conversation.
//
// The `discussion` pattern is generative-but-governed like every other
// ephemeral pattern: the caller fills slots, the kernel owns the graph. What
// this service adds on top is the FLOOR — the ephemeral attachment that makes
// the run's `say` steps authorized to speak into that one conversation, and
// nothing else. Without it a discussion would run silently: turns in the run
// context, nothing in the chat.

import type { ConductorEphemeralAttachmentsStore } from './ephemeralAttachmentsStore.js';
import type { ConductorEphemeralRunService, EphemeralRunHandle } from './ephemeralRunService.js';
import { DiscussionNotGrantedError, DiscussionPeerDisabledError } from './discussionHere.js';
import type { AgentChannelIdentityResolver } from './sayService.js';

export const DISCUSSION_PATTERN_ID = 'discussion';

/** ADR-0018 — marks a run context as a discussion's, so every utterance
 *  re-checks the participants' mutual consultation grants. */
export const DISCUSSION_AUTHORIZATION = 'mutual_consultation_grants';

/** Default lifetime of a discussion scaffold. Short: a bounded seven-turn
 *  exchange is minutes of work, and a stale scaffold holds the conversation's
 *  only attachment slot hostage. */
export const DISCUSSION_DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

export class DiscussionInvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscussionInvalidInputError';
  }
}

/** The conversation already carries someone else's live facilitation/discussion.
 *  `conductor_ephemeral_attachments` is UNIQUE per conversation, and two agents
 *  moderating the same chat was the exact #330 field-report incident. */
export class DiscussionConversationBusyError extends Error {
  constructor(readonly workflowId: string, message?: string) {
    super(message ?? `conversation is already attached to workflow ${workflowId}`);
    this.name = 'DiscussionConversationBusyError';
  }
}

/**
 * An agent without its own provisioned bot cannot appear in the chat as
 * itself. Refused HERE rather than mid-run: a discussion that starts and then
 * goes half-silent, with one side's turns landing and the other's dropped, is
 * worse than one that never started — the humans watching would read the
 * silence as the agent having nothing to say.
 */
export class DiscussionAgentHasNoIdentityError extends Error {
  constructor(readonly agentSlug: string, readonly channelType: string) {
    super(
      `agent '${agentSlug}' has no provisioned ${channelType} identity — it would have to speak through another bot's name, so the discussion is refused`,
    );
    this.name = 'DiscussionAgentHasNoIdentityError';
  }
}

/**
 * Turn ceiling. NOT the expected length — the expected length is "as long as
 * each turn still moves it forward", which the speakers decide by declaring
 * convergence. This is only the answer to "what if they never do".
 *
 * The first cut hard-capped every discussion at seven contributions, which
 * ended exchanges that were still getting better. Generous default, hard
 * maximum, and the caller may ask for less.
 */
export const DISCUSSION_DEFAULT_MAX_TURNS = 16;
export const DISCUSSION_MAX_TURNS_CEILING = 40;

export interface StartDiscussionInput {
  channelType: string;
  conversationId: string;
  /**
   * The agents taking part, in speaking order. Two or more. The first opens the
   * discussion and writes the closing summary; the floor then rotates through
   * the list.
   */
  participants: readonly string[];
  topic: string;
  /** The question the exchange should answer; falls back to the topic. */
  guidingQuestion?: string;
  /** Ceiling on contributions. Clamped to [2, DISCUSSION_MAX_TURNS_CEILING]. */
  maxTurns?: number;
  ttlMs?: number;
}

export interface DiscussionServiceDeps {
  ephemeralRuns: Pick<ConductorEphemeralRunService, 'createEphemeralRun'>;
  attachments: Pick<ConductorEphemeralAttachmentsStore, 'getByConversation' | 'upsertPending' | 'attachToWorkflow'>;
  /** Resolves the bot an agent speaks as — the same resolver the say service
   *  uses, so the start gate and the delivery rule cannot drift apart. */
  identityFor?: AgentChannelIdentityResolver;
  /**
   * #2090 (spec 2043 §5.3) — the reservation a conversation's one running
   * process holds, shared with native facilitations. A discussion takes it
   * before it claims the floor and is refused while a facilitation holds it.
   * Absent (no database-backed kernel store): the Conductor's own row is the
   * only guard, as before.
   */
  reservations?: DiscussionReservations;
  /**
   * ADR-0018 / spec 2042 §5.4 "One authorization" — every participant must be
   * enabled for agent-to-agent conversation here (#1018) and every two of them
   * must hold consultation grants for each other. Checked on EVERY start path
   * (chat capability and operator route alike), so no entry point starts a
   * discussion the grants do not allow. Absent = no check (test harness
   * without a store); production wires both.
   */
  peerGate?: (channelType: string, conversationId: string, agentSlug: string) => Promise<boolean>;
  mutualGrant?: DiscussionMutualGrant;
  now?: () => Date;
  log?: (msg: string) => void;
}

/** Both directions granted (and all switches on) for this channel type. */
export type DiscussionMutualGrant = (agentSlugA: string, agentSlugB: string, channelType: string) => Promise<boolean>;

export interface DiscussionReservations {
  /** `false`: another kind of process (a facilitation) holds the conversation. */
  reserve(channelType: string, conversationId: string): Promise<boolean>;
  release(channelType: string, conversationId: string, reason: string): Promise<void>;
}

function requireText(value: unknown, field: string, max = 2000): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DiscussionInvalidInputError(`${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new DiscussionInvalidInputError(`${field} exceeds ${max} characters`);
  }
  return trimmed;
}

export class ConductorDiscussionService {
  constructor(private readonly deps: DiscussionServiceDeps) {}

  async start(input: StartDiscussionInput): Promise<EphemeralRunHandle> {
    const channelType = requireText(input.channelType, 'channelType', 64);
    const conversationId = requireText(input.conversationId, 'conversationId', 512);
    const topic = requireText(input.topic, 'topic');

    const raw = Array.isArray(input.participants) ? input.participants : [];
    const participants: string[] = [];
    for (const [i, entry] of raw.entries()) {
      const slug = requireText(entry, `participants[${String(i)}]`, 128);
      // De-duplicate rather than reject: asking for the same agent twice is a
      // clumsy request, not a wrong one, and it must not put an agent in a
      // conversation with itself.
      if (!participants.includes(slug)) participants.push(slug);
    }
    if (participants.length < 2) {
      throw new DiscussionInvalidInputError(
        'a discussion needs at least two different agents — name the ones that should take part',
      );
    }
    const agentA = participants[0]!;

    const guidingQuestion =
      typeof input.guidingQuestion === 'string' && input.guidingQuestion.trim().length > 0
        ? input.guidingQuestion.trim().slice(0, 2000)
        : topic;

    // The ceiling exists so a discussion that never converges still ends. It is
    // deliberately not the expected length — the speakers end it themselves the
    // moment another round would add nothing.
    const requested = Number.isFinite(input.maxTurns) ? Math.floor(input.maxTurns!) : DISCUSSION_DEFAULT_MAX_TURNS;
    const maxTurns = Math.max(2, Math.min(requested, DISCUSSION_MAX_TURNS_CEILING));

    // Every voice must be able to appear as itself before anything starts.
    for (const slug of participants) {
      if (!this.deps.identityFor?.(slug, channelType)) {
        throw new DiscussionAgentHasNoIdentityError(slug, channelType);
      }
    }

    await this.assertAuthorized(participants, channelType, conversationId);

    const existing = await this.deps.attachments.getByConversation(channelType, conversationId);
    if (existing?.workflowId) {
      throw new DiscussionConversationBusyError(existing.workflowId);
    }

    // The shared reservation, before the floor is claimed: a facilitation in
    // this conversation refuses the discussion, and a discussion that holds
    // it refuses a facilitation.
    if (this.deps.reservations && !(await this.deps.reservations.reserve(channelType, conversationId))) {
      throw new DiscussionConversationBusyError('', 'a facilitation is running in this conversation');
    }
    try {
      return await this.claimAndStart({ input, agentA, participants, topic, guidingQuestion, channelType, conversationId, maxTurns });
    } catch (err) {
      await this.deps.reservations
        ?.release(channelType, conversationId, 'discussion did not start')
        .catch(() => undefined);
      throw err;
    }
  }

  /** ADR-0018 — peer gate per participant, mutual grants per pair. A failed
   *  lookup refuses: authorization fails closed. */
  private async assertAuthorized(
    participants: readonly string[],
    channelType: string,
    conversationId: string,
  ): Promise<void> {
    const { peerGate, mutualGrant } = this.deps;
    if (peerGate) {
      for (const slug of participants) {
        const enabled = await peerGate(channelType, conversationId, slug).catch(() => false);
        if (!enabled) throw new DiscussionPeerDisabledError(slug);
      }
    }
    if (!mutualGrant) return;
    for (const [i, a] of participants.entries()) {
      for (const b of participants.slice(i + 1)) {
        const granted = await mutualGrant(a, b, channelType).catch(() => false);
        if (!granted) throw new DiscussionNotGrantedError(a, b);
      }
    }
  }

  private async claimAndStart(args: {
    input: StartDiscussionInput;
    agentA: string;
    participants: string[];
    topic: string;
    guidingQuestion: string;
    channelType: string;
    conversationId: string;
    maxTurns: number;
  }): Promise<EphemeralRunHandle> {
    const { input, agentA, participants, topic, guidingQuestion, channelType, conversationId, maxTurns } = args;
    const now = (this.deps.now ?? (() => new Date()))();
    const ttlMs = input.ttlMs && input.ttlMs > 0 ? input.ttlMs : DISCUSSION_DEFAULT_TTL_MS;
    const expiresAt = new Date(now.getTime() + ttlMs);

    // Claim the floor BEFORE the run starts. `createEphemeralRun` creates and
    // starts atomically, so the first `say` can fire before we could attach a
    // workflow id — a pending row owned by this conversation is what the say
    // service accepts in that window.
    await this.deps.attachments.upsertPending({ agentSlug: agentA, channelType, channelKey: conversationId, expiresAt });

    const handle = await this.deps.ephemeralRuns.createEphemeralRun({
      agentId: agentA,
      patternId: DISCUSSION_PATTERN_ID,
      slots: {
        channels: { discussion: channelType },
      },
      // `participants` is the cast the floor rotates through; `speaker` is who
      // holds it right now, advanced by the executor after every utterance;
      // `closer` writes the summary. The graph names none of them — that is how
      // one pattern serves two voices or five.
      payload: {
        topic,
        guidingQuestion,
        conversationId,
        channelType,
        participants,
        authorization: DISCUSSION_AUTHORIZATION,
        speaker: agentA,
        closer: agentA,
        maxTurns,
      },
      ttlMs,
    });

    // Best-effort narrowing of the floor from "this conversation" to "this
    // workflow in this conversation". A failure here leaves the pending row,
    // which still scopes delivery to exactly this conversation and expires on
    // its own — worth a loud log, not worth killing a started discussion.
    await this.deps.attachments
      .attachToWorkflow({
        agentSlug: agentA,
        channelType,
        channelKey: conversationId,
        workflowId: handle.workflowId,
        roleKey: null,
        expiresAt: new Date(handle.expiresAt),
      })
      .catch((err: unknown) => {
        this.deps.log?.(
          `[conductor] discussion ${handle.workflowSlug}: attaching the conversation binding failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      });

    this.deps.log?.(
      `[conductor] discussion started in ${channelType}/${conversationId}: ${participants.join(' × ')} (max ${String(maxTurns)} turns) on "${topic}" (run ${handle.runId})`,
    );
    return handle;
  }
}
