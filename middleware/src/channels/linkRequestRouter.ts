// #2089 (spec 2043 §5.3) — link requests: a person addresses a facilitator
// INSIDE a group conversation in which none of its processes reads (the chat
// of a scheduled meeting), while the agent runs processes there that may
// link one. The turn asks the archetype plugin first, as a typed request.
//
// The kernel records the request (the conversation, the author as the turn
// states it, the processes it was offered to) and hands the plugin the text,
// nothing else: the message is not stored as a conversation event and gives
// no read access. Only such a request lets a process reserve that
// conversation as a session conversation (`reserveConversation` with its
// `linkRequestId`), so a link is always authorized from inside the target
// (criterion 48), never from the home conversation.

import type { LinkRequest, LinkRequestReply } from '@omadia/plugin-api';

import type { SessionConversationStore } from '../execution/sessionConversationStore.js';

export const LINK_REQUEST_TIMEOUT_MS = 20_000;
/** How long a link request can be used after it was made. */
export const LINK_REQUEST_TTL_MS = 60 * 60_000;

type Handler = (request: LinkRequest) => Promise<LinkRequestReply>;

export interface LinkRequestRouterDeps {
  readonly sessions: () => Pick<SessionConversationStore, 'linkingProcesses' | 'createLinkRequest' | 'dropLinkRequest'> | undefined;
  /** Does any process of this agent read that conversation already? Then
   *  the message is not a link request (the addressed-message route owns it). */
  readonly isRead: (scope: { agentSlug: string; channelType: string; conversationId: string }) => boolean;
  readonly timeoutMs?: number;
  readonly log?: (message: string) => void;
}

export interface LinkRequestTurn {
  readonly agent: { readonly id: string; readonly slug: string };
  readonly channelType: string;
  /** The readings of the turn's conversation id; the first is the target. */
  readonly conversationIds: readonly string[];
  readonly principalId: string;
  readonly displayName?: string;
  readonly text: string;
  readonly messageId?: string;
}

export class LinkRequestRouter {
  private handlers: { pluginId: string; agentSlug: string; handler: Handler }[] = [];

  constructor(private readonly deps: LinkRequestRouterDeps) {}

  register(pluginId: string, agentSlug: string, handler: Handler): () => void {
    const entry = { pluginId, agentSlug, handler };
    this.handlers = [...this.handlers, entry];
    return () => {
      this.handlers = this.handlers.filter((h) => h !== entry);
    };
  }

  /**
   * `undefined`: no plugin takes the message as a link request, and the
   * agent's ordinary turn answers. Otherwise the turn stays silent, or gives
   * `answer` as the agent's answer. Never throws.
   */
  async route(turn: LinkRequestTurn): Promise<{ answer?: string } | undefined> {
    const log = this.deps.log ?? (() => undefined);
    try {
      const candidates = this.handlers.filter((h) => h.agentSlug === turn.agent.slug);
      const conversationId = turn.conversationIds[0];
      const sessions = this.deps.sessions();
      if (candidates.length === 0 || conversationId === undefined || !sessions) return undefined;
      if (turn.conversationIds.some((id) => this.deps.isRead({ agentSlug: turn.agent.slug, channelType: turn.channelType, conversationId: id }))) {
        return undefined;
      }
      for (const { pluginId, handler } of candidates) {
        const processIds = await sessions.linkingProcesses(pluginId, turn.agent.id);
        if (processIds.length === 0) continue;
        const created = await sessions.createLinkRequest({
          pluginId,
          agentId: turn.agent.id,
          channelType: turn.channelType,
          conversationId,
          principalId: turn.principalId,
          ...(turn.messageId !== undefined ? { messageId: turn.messageId } : {}),
          processIds,
          ttlMs: LINK_REQUEST_TTL_MS,
        });
        const reply = await this.ask(handler, {
          linkRequestId: created.id,
          agentSlug: turn.agent.slug,
          channelType: turn.channelType,
          conversationId,
          principalId: turn.principalId,
          ...(turn.displayName !== undefined ? { displayName: turn.displayName } : {}),
          text: turn.text,
          ...(turn.messageId !== undefined ? { messageId: turn.messageId } : {}),
          processIds,
          expiresAt: created.expiresAt,
        });
        if (reply?.handled === true) {
          log(`[link-request] '${turn.agent.slug}' in ${turn.channelType}/${conversationId}: taken by ${pluginId}`);
          const answer = typeof reply.answer === 'string' ? reply.answer.trim() : '';
          return answer.length > 0 ? { answer } : {};
        }
        await sessions.dropLinkRequest(created.id);
      }
      return undefined;
    } catch (err) {
      log(`[link-request] routing failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private async ask(handler: Handler, request: LinkRequest): Promise<LinkRequestReply | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        handler(request),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            this.deps.log?.(`[link-request] '${request.agentSlug}': the plugin's handler did not answer in time`);
            resolve(undefined);
          }, this.deps.timeoutMs ?? LINK_REQUEST_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      this.deps.log?.(`[link-request] the plugin's handler failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
