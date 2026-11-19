// #2089 (spec 2043 §5.3) — private messages to an archetype agent.
//
// A facilitator is no assistant: a private request gets a fixed refusal. The
// one exception the spec makes is a person who takes part in a running
// facilitation of that facilitator: their status request is answered there,
// with that facilitation's status only.
//
// Who "takes part" is what the kernel can check: the person is a person
// target of an open execution scope of that agent (#2090). What the message
// IS (a status request or something else) is the plugin's judgement, so the
// plugin gets the message and answers or declines. Its answer is drawn from
// the scope like every other direct message: listed person, `status_only`
// restriction, deadline, budget, kill switch.

import type {
  ExecutionAuthorizationService,
  PrivateMessageReply,
  PrivateMessageRequest,
} from '@omadia/plugin-api';

export const PRIVATE_MESSAGE_TIMEOUT_MS = 20_000;
const MAX_ANSWER_LENGTH = 20_000;

type Handler = (request: PrivateMessageRequest) => Promise<PrivateMessageReply>;

export interface PrivateMessageRouterDeps {
  /** The processes of the agent whose open scopes list the person. */
  readonly processesListingPerson: (input: {
    agentId: string;
    channelType: string;
    principalId: string;
  }) => Promise<readonly { pluginId: string; processId: string }[]>;
  readonly executionFor: (pluginId: string) => ExecutionAuthorizationService | undefined;
  readonly timeoutMs?: number;
  readonly log?: (message: string) => void;
}

export class PrivateMessageRouter {
  private handlers: { pluginId: string; agentSlug: string; handler: Handler }[] = [];

  constructor(private readonly deps: PrivateMessageRouterDeps) {}

  register(pluginId: string, agentSlug: string, handler: Handler): () => void {
    const entry = { pluginId, agentSlug, handler };
    this.handlers = [...this.handlers, entry];
    return () => {
      this.handlers = this.handlers.filter((h) => h !== entry);
    };
  }

  /**
   * The answer to a private message, when a process of the agent takes it.
   * `undefined`: nobody does, and the caller gives the agent's ordinary
   * answer. Never throws.
   */
  async route(message: {
    agent: { id: string; slug: string };
    channelType: string;
    principalId: string;
    text: string;
  }): Promise<{ answer: string } | undefined> {
    const log = this.deps.log ?? (() => undefined);
    try {
      const listed = await this.deps.processesListingPerson({
        agentId: message.agent.id,
        channelType: message.channelType,
        principalId: message.principalId,
      });
      if (listed.length === 0) return undefined;
      for (const { pluginId, agentSlug, handler } of this.handlers) {
        if (agentSlug !== message.agent.slug) continue;
        const processIds = listed.filter((p) => p.pluginId === pluginId).map((p) => p.processId);
        if (processIds.length === 0) continue;
        const reply = await this.ask(handler, {
          agentSlug: message.agent.slug,
          channelType: message.channelType,
          principalId: message.principalId,
          text: message.text,
          processIds,
        });
        if (!reply || reply.handled !== true) continue;
        const text = typeof reply.text === 'string' ? reply.text.trim() : '';
        const authorization = reply.authorization;
        // The answer must be about one of the processes the person is listed
        // in; a plugin cannot answer from another process's scope.
        if (text.length === 0 || text.length > MAX_ANSWER_LENGTH || !authorization || !processIds.includes(authorization.processId)) {
          log(`[private-message] '${message.agent.slug}': the plugin's answer was not usable; the ordinary answer is given`);
          continue;
        }
        const execution = this.deps.executionFor(pluginId);
        const scope = (await execution?.listScopes(authorization.processId))?.find((s) => s.id === authorization.scopeId);
        if (!execution || !scope || scope.agentSlug !== message.agent.slug) continue;
        const granted = await execution.authorize({
          scopeId: scope.id,
          phase: authorization.phase,
          purpose: authorization.purpose,
          action: 'direct_message',
          target: { kind: 'person', channelType: message.channelType, principalId: message.principalId },
          ...(authorization.emission === 'prose' || authorization.emission === 'template'
            ? { emission: authorization.emission }
            : {}),
        });
        if (granted.outcome !== 'authorized') {
          log(
            `[private-message] '${message.agent.slug}' (process ${authorization.processId}): answer not authorized (${granted.code}); the ordinary answer is given`,
          );
          continue;
        }
        return { answer: text };
      }
      return undefined;
    } catch (err) {
      log(`[private-message] routing failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private async ask(handler: Handler, request: PrivateMessageRequest): Promise<PrivateMessageReply | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        handler(request),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), this.deps.timeoutMs ?? PRIVATE_MESSAGE_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      this.deps.log?.(`[private-message] the plugin's handler failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
