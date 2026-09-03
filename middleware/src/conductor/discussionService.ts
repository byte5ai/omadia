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

export const DISCUSSION_PATTERN_ID = 'discussion';

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
  constructor(readonly workflowId: string) {
    super(`conversation is already attached to workflow ${workflowId}`);
    this.name = 'DiscussionConversationBusyError';
  }
}

export interface StartDiscussionInput {
  channelType: string;
  conversationId: string;
  /** Agent slugs. `a` opens and writes the closing summary, `b` answers. */
  agentA: string;
  agentB: string;
  topic: string;
  /** The question the exchange should answer; falls back to the topic. */
  guidingQuestion?: string;
  ttlMs?: number;
}

export interface DiscussionServiceDeps {
  ephemeralRuns: Pick<ConductorEphemeralRunService, 'createEphemeralRun'>;
  attachments: Pick<ConductorEphemeralAttachmentsStore, 'getByConversation' | 'upsertPending' | 'attachToWorkflow'>;
  now?: () => Date;
  log?: (msg: string) => void;
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
    const agentA = requireText(input.agentA, 'agentA', 128);
    const agentB = requireText(input.agentB, 'agentB', 128);
    const topic = requireText(input.topic, 'topic');
    if (agentA === agentB) {
      throw new DiscussionInvalidInputError('agentA and agentB must be different agents — a discussion needs two voices');
    }
    const guidingQuestion =
      typeof input.guidingQuestion === 'string' && input.guidingQuestion.trim().length > 0
        ? input.guidingQuestion.trim().slice(0, 2000)
        : topic;

    const existing = await this.deps.attachments.getByConversation(channelType, conversationId);
    if (existing?.workflowId) {
      throw new DiscussionConversationBusyError(existing.workflowId);
    }

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
        agents: { a: agentA, b: agentB },
        channels: { discussion: channelType },
      },
      payload: { topic, guidingQuestion, conversationId, channelType },
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
      `[conductor] discussion started in ${channelType}/${conversationId}: '${agentA}' × '${agentB}' on "${topic}" (run ${handle.runId})`,
    );
    return handle;
  }
}
