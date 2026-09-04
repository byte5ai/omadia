// Agent-dialogue utterance delivery — the effect behind `Step.say`.
//
// WHY THIS EXISTS. Two agent bots in one Teams group chat cannot hold a topic
// conversation on their own, for three independent reasons:
//   1. Microsoft Teams does not deliver a bot's message to another bot, so
//      agent A's post never becomes an inbound activity for agent B.
//   2. A Conductor agent step's answer stays in the run context; nothing ever
//      publishes it into the conversation.
//   3. `conversationSendService.isPermitted` scopes proactive group posting to
//      the agent that OWNS the conversation's ephemeral attachment — and
//      `conductor_ephemeral_attachments` is UNIQUE per conversation, so a
//      second speaker is structurally refused.
// The dialogue is therefore relayed server-side: the Conductor runs the turns,
// the transcript lives in the run context, and this service projects each turn
// into the chat.
//
// AUTHORITY. This is not a bypass of the agent-ownership check — it replaces it
// with a STRICTER, run-derived one: the target conversation's attachment must
// belong to THIS run's workflow. Every participant of this run may speak;
// nobody else may. A `pending` attachment (no workflow yet) is accepted because
// `createEphemeralRun` creates and starts the run atomically — the first `say`
// can legitimately fire before `attachToWorkflow` has run.

import type { TargetedDeliveryOutcome } from '@omadia/channel-sdk';

import type { ConversationSendRegistry } from '../channels/conversationSendRegistry.js';
import type { EphemeralAttachment } from './ephemeralAttachmentsStore.js';

/** Hard cap on one utterance. Teams truncates far above this; the cap is about
 *  keeping a runaway generation from flooding a chat, not about the protocol. */
export const SAY_TEXT_MAX_CHARS = 4000;

/**
 * Resolves the provisioned channel identity an agent speaks as — its OWN bot.
 * Backed by `OrchestratorRegistry.channelIdentityFor`. Absent (no registry)
 * means no agent can be shown to own an identity, and every say is refused.
 */
export type AgentChannelIdentityResolver = (
  agentSlug: string,
  channelType: string,
) => { channelKey: string } | undefined;

export interface ConductorSayInput {
  /** The run's workflow; null on a run whose workflow could not be resolved. */
  workflowId: string | null;
  runId: string;
  /** The speaking agent's slug — audit provenance, and the default speaker name. */
  agentSlug: string;
  /** Display name for the transcript and the log line. NOT written into the
   *  chat: the message carries the agent's own bot as its sender, and a name
   *  in the text would be a second claim about the same thing. */
  speaker: string;
  channelType: string;
  conversationId: string;
  text: string;
}

export type ConductorSayOutcome =
  | { said: true }
  | {
      said: false;
      /** Machine-readable cause, mirrored into the step result so a graph can see it. */
      reason:
        | 'no_workflow'
        | 'no_conversation'
        | 'empty_text'
        | 'no_attachment'
        | 'foreign_workflow'
        | 'no_provider'
        | 'no_identity'
        | 'channel_error';
      message: string;
    };

export interface ConductorSayDeps {
  attachments: { getByConversation(channelType: string, channelKey: string): Promise<EphemeralAttachment | undefined> };
  providers: Pick<ConversationSendRegistry, 'get'>;
  /** Resolves the bot the speaking agent IS. Absent = nobody can be shown to
   *  own an identity, so nothing is posted. */
  identityFor?: AgentChannelIdentityResolver;
  log?: (msg: string) => void;
}

/** Strip every fenced ```json block. An agent step's machine verdict is for the
 *  transition guards — a wall of JSON in a human chat is noise, and re-posting
 *  it invites the next speaker to treat it as conversation content. */
export function stripFencedJson(text: string): string {
  return text.replace(/```json\s*\n[\s\S]*?```/g, '').trim();
}

/**
 * The utterance as it appears in the chat: the agent's words, nothing else.
 *
 * There is deliberately NO `**Speaker:**` prefix. Every turn is posted through
 * the speaking agent's own bot, so the chat already shows who is talking — its
 * name, its avatar, its message bubble. A prefix would be a second, weaker
 * claim about the same thing, and the moment the two disagreed the prefix
 * would be the lie. Where an agent cannot post in its own name, the answer is
 * to not post it (see `no_identity`), not to label it.
 */
export function formatUtterance(text: string): string {
  return text.length > SAY_TEXT_MAX_CHARS ? `${text.slice(0, SAY_TEXT_MAX_CHARS)}…` : text;
}

export class ConductorSayService {
  constructor(private readonly deps: ConductorSayDeps) {}

  /**
   * Publish one agent utterance into the run's bound conversation.
   *
   * NEVER throws: a run must not die because a chat was unreachable. Every
   * failure is a named outcome the caller mirrors into the step result
   * (`said: false`), so the graph — and the operator lens — see that the turn
   * happened but was not heard.
   */
  async say(input: ConductorSayInput): Promise<ConductorSayOutcome> {
    // A REHEARSAL MUST NOT SPEAK. Preview and dry-run turns carry no workflow
    // id, and the `pending` acceptance below would otherwise let a rehearsal
    // post into a real chat that happens to have an unattached binding — the
    // one hole a run-derived authority could still leave open.
    const workflowId = typeof input.workflowId === 'string' ? input.workflowId.trim() : '';
    if (workflowId.length === 0) {
      return {
        said: false,
        reason: 'no_workflow',
        message: 'this turn belongs to no persisted workflow (preview or dry run) — rehearsals never post',
      };
    }

    const conversationId = typeof input.conversationId === 'string' ? input.conversationId.trim() : '';
    if (conversationId.length === 0) {
      return {
        said: false,
        reason: 'no_conversation',
        message: 'run context carries no conversationId — a say step needs a bound conversation',
      };
    }

    const text = stripFencedJson(input.text ?? '');
    if (text.length === 0) {
      return { said: false, reason: 'empty_text', message: 'the agent produced no publishable text' };
    }

    const attachment = await this.deps.attachments
      .getByConversation(input.channelType, conversationId)
      .catch((err: unknown) => {
        this.deps.log?.(
          `[conductor] say authority lookup failed for ${input.channelType}/${conversationId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      });
    // Fail closed: no attachment (or a lookup we could not complete) means we
    // cannot prove this run owns the floor.
    if (!attachment) {
      return {
        said: false,
        reason: 'no_attachment',
        message: `no ephemeral attachment binds ${input.channelType}/${conversationId} — this run holds no floor there`,
      };
    }
    if (attachment.workflowId !== null && attachment.workflowId !== workflowId) {
      return {
        said: false,
        reason: 'foreign_workflow',
        message: `${input.channelType}/${conversationId} is bound to another workflow — refusing to speak into a foreign facilitation`,
      };
    }

    const provider = this.deps.providers.get(input.channelType);
    if (!provider) {
      return {
        said: false,
        reason: 'no_provider',
        message: `no conversation-send provider registered for channel type '${input.channelType}'`,
      };
    }

    // AN AGENT SPEAKS IN ITS OWN NAME OR NOT AT ALL.
    //
    // In a group chat holding several provisioned bots, posting through some
    // other identity puts this agent's words under another bot's name and
    // avatar, and nobody in the chat can tell. Prefixing the text with a name
    // is not a fix — it is a second, weaker claim next to the sender the chat
    // actually shows. So a missing identity is a refusal, not a degradation.
    const identity = this.deps.identityFor?.(input.agentSlug, input.channelType);
    if (!identity) {
      return {
        said: false,
        reason: 'no_identity',
        message: `agent '${input.agentSlug}' has no provisioned ${input.channelType} identity — it cannot speak in its own name here, and it will not speak in someone else's`,
      };
    }

    let outcome: TargetedDeliveryOutcome;
    try {
      outcome = await provider.sendToConversation(
        conversationId,
        { text: formatUtterance(text) },
        { asChannelKey: identity.channelKey },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log?.(`[conductor] say by '${input.agentSlug}' threw: ${message}`);
      return { said: false, reason: 'channel_error', message };
    }
    if (outcome.outcome !== 'delivered') {
      this.deps.log?.(
        `[conductor] say by '${input.agentSlug}' into ${input.channelType}/${conversationId} undelivered (${outcome.code}): ${outcome.message}`,
      );
      return { said: false, reason: 'channel_error', message: outcome.message };
    }
    this.deps.log?.(
      `[conductor] say by '${input.agentSlug}' delivered into ${input.channelType}/${conversationId} as ${identity.channelKey} (run ${input.runId})`,
    );
    return { said: true };
  }
}
