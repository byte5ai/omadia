/**
 * #2055 — the ChatAgent a channel gets from routing (spec 2042 §5.3, §5.6):
 * the management layer in front of the routed agent.
 *
 *  - `/agent <name>`, `/agent` and `/agents` are the management layer's: the
 *    selection is stored and the sender gets a `system` notice. No agent runs.
 *  - every other message reaches the routed agent, or, when routing refused
 *    the turn, is answered with the refusal notice from `system`.
 *
 * Channels just pass text through; every channel gets the same plain-text
 * agent choice without code of its own.
 */

import {
  parseAgentCommand,
  type AgentSelectionService,
  type ChatAgent,
  type ChatStreamEvent,
  type SemanticAnswer,
} from '@omadia/channel-sdk';
import { SYSTEM_SPEAKER, type NoticeAgentRef, type SystemNotice } from '@omadia/plugin-api';

import { buildSystemNotice } from './systemNotices.js';

export interface ManagementTurnContext {
  readonly channelType: string;
  readonly conversationKey: string;
  readonly principal?: string;
  readonly locale?: string;
  readonly selection?: AgentSelectionService;
  /**
   * Spec 2042 §5.3 — the turn arrived through this agent's OWN bot. Routing
   * gives that bot to its agent before any selection, so `/agent` here would
   * store a choice that can never apply; the sender is told whose bot it is.
   */
  readonly ownBotOf?: NoticeAgentRef;
}

/** A turn the management layer answers: speaker `system`, no model. */
export function systemNoticeDone(notice: SystemNotice): Extract<ChatStreamEvent, { type: 'done' }> {
  return {
    type: 'done',
    answer: notice.text,
    toolCalls: 0,
    iterations: 0,
    speaker: SYSTEM_SPEAKER,
    systemNotice: notice,
  };
}

export function systemNoticeAnswer(notice: SystemNotice): SemanticAnswer {
  return { text: notice.text, speaker: SYSTEM_SPEAKER, systemNotice: notice };
}

async function commandNotice(text: string, context: ManagementTurnContext): Promise<SystemNotice | undefined> {
  const command = parseAgentCommand(text);
  if (!command) return undefined;
  if (context.ownBotOf) {
    return buildSystemNotice('agent_own_bot', {
      agent: context.ownBotOf,
      ...(context.locale ? { locale: context.locale } : {}),
    });
  }
  if (!context.selection) return undefined;
  if (context.principal === undefined && command.kind !== 'list') {
    // A selection is kept per person; without knowing the sender there is no
    // one to keep it for.
    return buildSystemNotice('no_agent', context.locale ? { locale: context.locale } : {});
  }
  return context.selection.handle(command, {
    channelType: context.channelType,
    conversationKey: context.conversationKey,
    principal: context.principal ?? 'user:anonymous',
    ...(context.locale ? { locale: context.locale } : {}),
  });
}

/**
 * The routed agent behind the management layer's commands; `inner`
 * undefined = routing refused the turn and `refusal` is the answer.
 */
export function managementChatAgent(
  inner: ChatAgent | undefined,
  context: ManagementTurnContext,
  refusal?: SystemNotice,
): ChatAgent {
  const fallbackNotice = (): SystemNotice =>
    refusal ?? buildSystemNotice('no_agent', context.locale ? { locale: context.locale } : {});
  // The sender's language reaches the agent's own notices (identity guard).
  const withLocale = <I extends { locale?: string }>(input: I): I =>
    input.locale === undefined && context.locale !== undefined ? { ...input, locale: context.locale } : input;
  const chat = async (input: Parameters<ChatAgent['chat']>[0]): Promise<SemanticAnswer> => {
    const notice = await commandNotice(input.userMessage, context);
    if (notice) return systemNoticeAnswer(notice);
    return inner ? inner.chat(withLocale(input)) : systemNoticeAnswer(fallbackNotice());
  };
  async function* chatStream(
    input: Parameters<ChatAgent['chatStream']>[0],
    observer?: Parameters<ChatAgent['chatStream']>[1],
  ): AsyncGenerator<ChatStreamEvent> {
    const notice = await commandNotice(input.userMessage, context);
    if (notice) {
      yield systemNoticeDone(notice);
      return;
    }
    if (!inner) {
      yield systemNoticeDone(fallbackNotice());
      return;
    }
    yield* inner.chatStream(withLocale(input), observer);
  }
  if (!inner) return { chat, chatStream };
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'chat') return chat;
      if (prop === 'chatStream') return chatStream;
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
