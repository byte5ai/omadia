// 'conversationSend@2' (#2091): every post, direct message, card update and
// readiness check of an archetype agent is an authorized action.
//
// The kernel takes the authorization from the named execution scope first
// (#2090): the target must be one the scope lists, and the scope must be
// open, inside its deadline and budget, and not stopped. Only then the action
// goes through the same own-identity path as the first major. What the first
// major asked a message subscription ("it only posts where it moderates") is
// here the scope's answer, so a `closing` scope still posts to a conversation
// whose reservation was released.

import type { TargetedDeliveryOutcome, TargetedMessage } from '@omadia/channel-sdk';
import type {
  CardUpdateOutcome,
  ChannelReadinessReport,
  ExecutionActionType,
  ExecutionAuthorizationService,
  ExecutionTarget,
  ScopedCardUpdateRequest,
  ScopedConversationSendRequest,
  ScopedConversationSendService,
  ScopedDirectSendRequest,
  ScopedReadinessRequest,
  ScopedSendOutcome,
  SendAuthorization,
} from '@omadia/plugin-api';

import type { ConversationMessageHub } from './conversationMessages/hub.js';
import type { ConversationSendInput, ConversationSendService } from './conversationSendService.js';

type Unreachable = Extract<ScopedSendOutcome, { outcome: 'unreachable' }>;

export interface ScopedSendServiceDeps {
  /** The kernel-known id of the calling plugin. */
  readonly callerPluginId: string;
  /** The caller's execution authorization; absent without a database. */
  readonly execution: () => ExecutionAuthorizationService | undefined;
  readonly conversation: ConversationSendService;
  /** An own-identity direct message, permitted by the scope. */
  readonly direct: (
    input: { channelType: string; principal: string; message: TargetedMessage; asAgentSlug: string; userRef?: { kind: string; id: string } },
    subscriptions: ReturnType<ConversationMessageHub['subscriptionsOfProcess']>,
  ) => Promise<TargetedDeliveryOutcome>;
  readonly messages?: Pick<ConversationMessageHub, 'subscriptionsOfProcess' | 'bindProcessMessage'>;
  readonly readiness?: (request: { agentSlug: string; channelType: string; conversationId: string }) => Promise<ChannelReadinessReport>;
  readonly log?: (message: string) => void;
}

const isText = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

const refusal = (code: string, message: string, extra: Partial<Unreachable> = {}): Unreachable => ({
  outcome: 'unreachable',
  code,
  message,
  ...extra,
});

export function createScopedSendService(deps: ScopedSendServiceDeps): ScopedConversationSendService {
  const log = deps.log ?? (() => undefined);

  /**
   * Draw one action from the scope. The scope must be the named process's and
   * the named agent's; a scope of another plugin is not in the caller's list
   * and reads as unknown.
   */
  async function authorize(
    agentSlug: unknown,
    authorization: Partial<SendAuthorization> | undefined,
    action: ExecutionActionType,
    target: ExecutionTarget | undefined,
    fixed: { purpose?: SendAuthorization['purpose']; emission?: SendAuthorization['emission'] } = {},
  ): Promise<{ authorizationId: string; processId: string } | Unreachable> {
    if (!isText(agentSlug, 128)) return refusal('not_permitted', 'agentSlug is required');
    if (!authorization || !isText(authorization.scopeId, 128) || !isText(authorization.processId, 200)) {
      return refusal('not_authorized', 'authorization.scopeId and authorization.processId are required', {
        executionCode: 'invalid_request',
      });
    }
    const execution = deps.execution();
    if (!execution) return refusal('not_authorized', 'execution authorization needs a database', { executionCode: 'unavailable' });
    const scope = (await execution.listScopes(authorization.processId)).find((s) => s.id === authorization.scopeId);
    if (!scope || scope.agentSlug !== agentSlug) {
      return refusal('not_authorized', 'no such scope for this process and agent', { executionCode: 'unknown_scope' });
    }
    const emission = fixed.emission ?? authorization.emission;
    const granted = await execution.authorize({
      scopeId: scope.id,
      phase: authorization.phase as SendAuthorization['phase'],
      purpose: (fixed.purpose ?? authorization.purpose) as SendAuthorization['purpose'],
      action,
      ...(target ? { target } : {}),
      ...(emission ? { emission } : {}),
    });
    if (granted.outcome === 'refused') {
      log(
        `[channels] ${action} by '${agentSlug}' (process ${authorization.processId}) not authorized: ${granted.code}`,
      );
      return refusal('not_authorized', granted.message, { executionCode: granted.code });
    }
    return { authorizationId: granted.authorizationId, processId: authorization.processId };
  }

  const emissionOf = (authorization: Partial<SendAuthorization> | undefined): Unreachable | undefined =>
    authorization?.emission === 'prose' || authorization?.emission === 'template'
      ? undefined
      : refusal('not_authorized', "authorization.emission is 'prose' or 'template'", { executionCode: 'invalid_request' });

  const subscriptionsOf = (processId: string, agentSlug: string) =>
    deps.messages?.subscriptionsOfProcess(deps.callerPluginId, processId, agentSlug) ?? [];

  return {
    capabilities: (channelType) => deps.conversation.capabilities(channelType),

    async sendToConversation(request: ScopedConversationSendRequest): Promise<ScopedSendOutcome> {
      if (!isText(request?.channelType, 64) || !isText(request.conversationId)) {
        return refusal('not_permitted', 'channelType and conversationId are required');
      }
      const bad = emissionOf(request.authorization);
      if (bad) return bad;
      const granted = await authorize(request.agentSlug, request.authorization, 'post', {
        kind: 'conversation',
        channelType: request.channelType,
        conversationId: request.conversationId,
      });
      if ('outcome' in granted) return granted;
      const input: ConversationSendInput = {
        agentSlug: request.agentSlug,
        channelType: request.channelType,
        conversationId: request.conversationId,
        message: request.message,
        asOwnIdentity: true,
      };
      const outcome = await deps.conversation.sendToConversation(input, deps.callerPluginId, {
        subscriptions: subscriptionsOf(granted.processId, request.agentSlug),
      });
      if (outcome.outcome !== 'delivered') {
        return refusal(outcome.code, outcome.message, { authorizationId: granted.authorizationId });
      }
      const { messageId, cardMessageId } = outcome as { messageId?: string; cardMessageId?: string };
      const cardId = (request.message as { card?: { cardId?: unknown } } | undefined)?.card?.cardId;
      // The kernel records which process the message and the card belong to:
      // a reply or a card answer then reaches this process alone.
      try {
        const scope = {
          agentSlug: request.agentSlug,
          channelType: request.channelType,
          conversationId: request.conversationId,
          processId: granted.processId,
        };
        for (const id of [messageId, cardMessageId]) {
          if (isText(id)) await deps.messages?.bindProcessMessage(scope, deps.callerPluginId, { messageId: id });
        }
        if (isText(cardId)) await deps.messages?.bindProcessMessage(scope, deps.callerPluginId, { cardId });
      } catch (err) {
        log(`[channels] recording the process of a posted message failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return {
        outcome: 'delivered',
        authorizationId: granted.authorizationId,
        ...(isText(messageId) ? { messageId } : {}),
        ...(isText(cardMessageId) ? { cardMessageId } : {}),
      };
    },

    async sendToPerson(request: ScopedDirectSendRequest): Promise<ScopedSendOutcome> {
      if (!isText(request?.channelType, 64) || !isText(request.principal) || !isText(request.message?.text, 200_000)) {
        return refusal('not_permitted', 'channelType, principal and message.text are required');
      }
      const principalId = request.principal.startsWith('user:') ? request.principal.slice('user:'.length) : '';
      if (!principalId) return refusal('not_permitted', `'${request.principal}' is not a user principal ('user:<id>')`);
      const bad = emissionOf(request.authorization);
      if (bad) return bad;
      const granted = await authorize(request.agentSlug, request.authorization, 'direct_message', {
        kind: 'person',
        channelType: request.channelType,
        principalId,
      });
      if ('outcome' in granted) return granted;
      // Second line, the kernel's own knowledge: the person must be a member
      // or an author of a conversation of this process.
      const outcome = await deps.direct(
        {
          channelType: request.channelType,
          principal: request.principal,
          message: { text: request.message.text },
          asAgentSlug: request.agentSlug,
          ...(request.userRef ? { userRef: request.userRef } : {}),
        },
        subscriptionsOf(granted.processId, request.agentSlug),
      );
      if (outcome.outcome !== 'delivered') {
        return refusal(outcome.code, outcome.message, { authorizationId: granted.authorizationId });
      }
      const { messageId, conversationId } = outcome;
      return {
        outcome: 'delivered',
        authorizationId: granted.authorizationId,
        ...(isText(messageId) ? { messageId } : {}),
        // The private conversation the message went into, as the channel
        // reported it: what lets the caller match a later reply there.
        ...(isText(conversationId) ? { conversationId } : {}),
      };
    },

    async updateCard(request: ScopedCardUpdateRequest): Promise<CardUpdateOutcome | Unreachable> {
      if (!isText(request?.channelType, 64) || !isText(request.conversationId)) {
        return refusal('not_permitted', 'channelType and conversationId are required');
      }
      const bad = emissionOf(request.authorization);
      if (bad) return bad;
      const granted = await authorize(request.agentSlug, request.authorization, 'card_update', {
        kind: 'conversation',
        channelType: request.channelType,
        conversationId: request.conversationId,
      });
      if ('outcome' in granted) return granted;
      return deps.conversation.updateCard(
        {
          agentSlug: request.agentSlug,
          channelType: request.channelType,
          conversationId: request.conversationId,
          cardMessageId: request.cardMessageId,
          update: request.update,
        },
        deps.callerPluginId,
        { subscriptions: subscriptionsOf(granted.processId, request.agentSlug) },
      );
    },

    async checkReadiness(request: ScopedReadinessRequest) {
      if (!isText(request?.channelType, 64) || !isText(request.conversationId)) {
        return refusal('not_permitted', 'channelType and conversationId are required');
      }
      if (!deps.readiness) return refusal('channel_error', 'no channel readiness is wired on this host');
      const granted = await authorize(request.agentSlug, request.authorization, 'check', undefined, {
        purpose: 'readiness_check',
      });
      if ('outcome' in granted) return granted;
      try {
        const report = await deps.readiness({
          agentSlug: request.agentSlug,
          channelType: request.channelType,
          conversationId: request.conversationId,
        });
        return { outcome: 'checked', report, authorizationId: granted.authorizationId };
      } catch (err) {
        return refusal('channel_error', err instanceof Error ? err.message : String(err), {
          authorizationId: granted.authorizationId,
        });
      }
    },
  };
}
