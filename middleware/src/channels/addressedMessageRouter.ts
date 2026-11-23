// #2089 — who answers a message that addresses a facilitator in a group
// conversation where one of its processes listens in `addressed` mode (a
// facilitation in follow-up).
//
// Such a mention arrives twice: as a turn the channel starts for the agent,
// and as an event for the process's subscription. Left alone, both answer.
// The turn is made the one owner: before the agent's model runs, the plugin
// that runs the process is asked whether a process takes the message. If it
// does, the turn stays silent and the process answers through its own sends;
// if not, the agent's ordinary turn runs. The hub, for its part, stores such
// a mention for the process but no longer pushes it (see
// `ConversationMessageHub`, `ownsAddressedTurns`).

import type { AddressedMessageReply, AddressedMessageRequest } from '@omadia/plugin-api';

export const ADDRESSED_MESSAGE_TIMEOUT_MS = 20_000;

type Handler = (request: AddressedMessageRequest) => Promise<AddressedMessageReply>;

/** A process that listens in `addressed` mode in a conversation. */
export interface AddressedListener {
  readonly pluginId: string;
  readonly processId: string;
}

export interface AddressedMessageRouterDeps {
  /** The processes of the agent that listen in `addressed` mode there. */
  readonly listeners: (scope: { agentSlug: string; channelType: string; conversationId: string }) => readonly AddressedListener[];
  /** The stored event of a message for one process, if it is stored. */
  readonly eventIdOf?: (
    scope: { agentSlug: string; channelType: string; conversationId: string; processId: string },
    pluginId: string,
    messageId: string,
  ) => Promise<string | undefined>;
  readonly timeoutMs?: number;
  readonly log?: (message: string) => void;
}

export interface AddressedTurn {
  readonly agentSlug: string;
  readonly channelType: string;
  /** The readings of the turn's conversation id; the first one in which a
   *  process listens is the conversation. */
  readonly conversationIds: readonly string[];
  readonly principalId: string;
  readonly text: string;
  readonly messageId?: string;
}

export class AddressedMessageRouter {
  private handlers: { pluginId: string; agentSlug: string; handler: Handler }[] = [];

  constructor(private readonly deps: AddressedMessageRouterDeps) {}

  register(pluginId: string, agentSlug: string, handler: Handler): () => void {
    const entry = { pluginId, agentSlug, handler };
    this.handlers = [...this.handlers, entry];
    return () => {
      this.handlers = this.handlers.filter((h) => h !== entry);
    };
  }

  /** Does this plugin decide addressed turns of this agent? Then the hub
   *  leaves a plain mention to the turn. */
  owns(pluginId: string, agentSlug: string): boolean {
    return this.handlers.some((h) => h.pluginId === pluginId && h.agentSlug === agentSlug);
  }

  /**
   * `true`: a process takes the message, and the agent's turn stays silent.
   * `false`: nobody does (no listening process, no handler, declined, failed
   * or too slow), and the agent's ordinary turn runs. Never throws.
   */
  async route(turn: AddressedTurn): Promise<boolean> {
    const log = this.deps.log ?? (() => undefined);
    try {
      const candidates = this.handlers.filter((h) => h.agentSlug === turn.agentSlug);
      if (candidates.length === 0) return false;
      for (const conversationId of turn.conversationIds) {
        const scope = { agentSlug: turn.agentSlug, channelType: turn.channelType, conversationId };
        const listeners = this.deps.listeners(scope);
        if (listeners.length === 0) continue;
        for (const { pluginId, handler } of candidates) {
          const processIds = [...new Set(listeners.filter((l) => l.pluginId === pluginId).map((l) => l.processId))];
          if (processIds.length === 0) continue;
          const eventId = await this.eventIdOf(scope, pluginId, processIds, turn.messageId);
          const reply = await this.ask(handler, {
            agentSlug: turn.agentSlug,
            channelType: turn.channelType,
            conversationId,
            principalId: turn.principalId,
            text: turn.text,
            ...(turn.messageId !== undefined ? { messageId: turn.messageId } : {}),
            ...(eventId !== undefined ? { eventId } : {}),
            processIds,
          });
          if (reply?.handled === true) {
            log(`[addressed-message] '${turn.agentSlug}' in ${turn.channelType}/${conversationId}: taken by a process of ${pluginId}`);
            return true;
          }
        }
        // The conversation is this one; its processes declined.
        return false;
      }
      return false;
    } catch (err) {
      log(`[addressed-message] routing failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async eventIdOf(
    scope: { agentSlug: string; channelType: string; conversationId: string },
    pluginId: string,
    processIds: readonly string[],
    messageId: string | undefined,
  ): Promise<string | undefined> {
    if (messageId === undefined || !this.deps.eventIdOf) return undefined;
    for (const processId of processIds) {
      try {
        const eventId = await this.deps.eventIdOf({ ...scope, processId }, pluginId, messageId);
        if (eventId !== undefined) return eventId;
      } catch {
        // Not knowing the event is an honest answer; the request goes without.
      }
    }
    return undefined;
  }

  private async ask(handler: Handler, request: AddressedMessageRequest): Promise<AddressedMessageReply | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        handler(request),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            this.deps.log?.(
              `[addressed-message] '${request.agentSlug}': the plugin's handler did not answer in time; the agent's ordinary turn answers`,
            );
            resolve(undefined);
          }, this.deps.timeoutMs ?? ADDRESSED_MESSAGE_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      this.deps.log?.(`[addressed-message] the plugin's handler failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
