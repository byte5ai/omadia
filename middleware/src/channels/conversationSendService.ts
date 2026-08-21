// Conversation-addressed proactive send (#330 C3b) — the kernel service a
// granted agent plugin (the Facilitator's stall-nudge) reaches as
// 'conversationSend'. Deliberately thin next to targetedDeliveryService: no
// principal resolution, one conversation, one delivery — and like every
// delivery path here, unreachability is a named outcome, never a throw.

import type { TargetedDeliveryOutcome, TargetedMessage } from '@omadia/channel-sdk';

import type { ConversationSendRegistry } from './conversationSendRegistry.js';

export interface ConversationSendService {
  sendToConversation(input: {
    agentSlug: string;
    channelType: string;
    conversationId: string;
    message: TargetedMessage;
  }): Promise<TargetedDeliveryOutcome>;
}

export function createConversationSendService(deps: {
  providers: ConversationSendRegistry;
  /** Scope authority (review H1): true iff the calling agent holds an
   *  ephemeral attachment for this conversation (its own auto-bound
   *  facilitation). Absent (no database) → FAIL CLOSED: without a scope
   *  authority nobody gets to post into groups proactively. */
  isPermitted?: (agentSlug: string, channelType: string, conversationId: string) => Promise<boolean>;
  log?: (msg: string) => void;
}): ConversationSendService {
  const log = deps.log ?? (() => undefined);
  return {
    async sendToConversation(input) {
      if (typeof input.agentSlug !== 'string' || input.agentSlug.trim().length === 0) {
        return { outcome: 'unreachable', code: 'not_permitted', message: 'agentSlug is required' };
      }
      const permitted = deps.isPermitted
        ? await deps.isPermitted(input.agentSlug, input.channelType, input.conversationId).catch(() => false)
        : false;
      if (!permitted) {
        log(`[channels] conversation send by '${input.agentSlug}' to ${input.channelType}/${input.conversationId} refused (no owned ephemeral attachment)`);
        return {
          outcome: 'unreachable',
          code: 'not_permitted',
          message: `agent '${input.agentSlug}' holds no ephemeral attachment for this conversation — proactive group posting is scoped to own facilitations`,
        };
      }
      const provider = deps.providers.get(input.channelType);
      if (!provider) {
        return {
          outcome: 'unreachable',
          code: 'channel_error',
          message: `no conversation-send provider registered for channel type '${input.channelType}'`,
        };
      }
      try {
        return await provider.sendToConversation(input.conversationId, input.message);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`[channels] conversation send to ${input.channelType}/${input.conversationId} threw: ${message}`);
        return { outcome: 'unreachable', code: 'channel_error', message };
      }
    },
  };
}
