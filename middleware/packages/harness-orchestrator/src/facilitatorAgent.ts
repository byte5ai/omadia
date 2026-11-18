/**
 * #2060 — what a facilitator's `ChatAgent` answers outside a facilitation
 * (spec 2043 §2.3, "assistance outside a facilitation").
 *
 * A facilitator is not an assistant. Every chat surface ends in the bundle's
 * `ChatAgent`, so this wrapper is the one place that decides, without a model
 * call, whether a turn reaches the model at all:
 *
 *   - a turn the facilitation ENGINE runs (`runAsEngineTurn`, the `agentTurn`
 *     service) always does: it is the moderation itself;
 *   - a turn from a GROUP conversation does: that is where a person asks the
 *     facilitator to start, and the model only has the engine's tools and the
 *     neutrality contract to answer with;
 *   - everything else — a personal chat, the web chat, an API call, a
 *     workflow step, a turn whose origin nobody stated — gets a fixed,
 *     friendly refusal that says what the facilitator does.
 *
 * Fail-closed in the direction that matters: a turn that cannot be placed in
 * a group is treated as a private request for help. The refusal is not
 * logged as a session and not captured; nothing was learned.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  toSemanticAnswer,
  type ChatAgent,
  type ChatStreamEvent,
  type ChatStreamObserver,
  type ChatTurnInput,
  type SemanticAnswer,
} from '@omadia/channel-sdk';
import type { NativeToolCallContext } from '@omadia/plugin-api';


export interface EngineTurnScope {
  /** The engine plugin that asked for the turn. */
  readonly pluginId: string;
  /** What the engine's own tools are told about this turn (#2043): the
   *  conversation, the stored inbound event and the caller, as the kernel
   *  established them. See `toolCallContext.ts`. */
  readonly toolContext?: Omit<NativeToolCallContext, 'agentSlug'>;
}

/**
 * One store per PROCESS, not per module instance. This package can be loaded
 * twice (the kernel imports the build, a bundled plugin may resolve another
 * copy); a scope entered through one copy must be visible through the other,
 * or an engine turn would be refused as a private request.
 */
export function processWideStore<T>(key: string): AsyncLocalStorage<T> {
  const registry = globalThis as unknown as Record<symbol, AsyncLocalStorage<T> | undefined>;
  const symbol = Symbol.for(key);
  const existing = registry[symbol];
  if (existing) return existing;
  const created = new AsyncLocalStorage<T>();
  registry[symbol] = created;
  return created;
}

const engineTurns = processWideStore<EngineTurnScope>('omadia.facilitator.engineTurn');

/**
 * Run `fn` as a turn of the facilitation engine. Kernel-only: the `agentTurn`
 * service is the single caller, after it checked that the calling plugin is
 * the instance's engine. Not exported to plugins.
 */
export function runAsEngineTurn<T>(scope: EngineTurnScope, fn: () => T): T {
  return engineTurns.run(scope, fn);
}

export function currentEngineTurn(): EngineTurnScope | undefined {
  return engineTurns.getStore();
}

/** A turn from a conversation with more than one human in it. */
export function isGroupTurn(input: ChatTurnInput): boolean {
  const kind = input.origin?.scope.kind;
  return kind === 'conversation' || kind === 'group';
}

export function facilitatorRefusalText(opts: {
  readonly name?: string | undefined;
  readonly locale?: string | undefined;
}): string {
  const name = opts.name?.trim();
  if (opts.locale?.toLowerCase().startsWith('de')) {
    return (
      `${name ? `Ich bin ${name}, ` : 'Ich bin '}Moderator und kein Assistent: ` +
      'Fragen beantworten oder Aufgaben übernehmen kann ich nicht. ' +
      'Ich moderiere Entscheidungen, Abstimmungen, Priorisierungen und ähnliche Gruppenprozesse. ' +
      'Wenn ihr so etwas vorhabt, fügt mich dem Gruppenchat hinzu und bittet mich dort, eine Moderation zu starten.'
    );
  }
  return (
    `${name ? `I am ${name}, a facilitator` : 'I am a facilitator'}, not an assistant: ` +
    'I cannot answer questions or take on tasks. ' +
    'I moderate decisions, votes, prioritisations and similar group processes. ' +
    'If you are planning one, add me to the group chat and ask me there to start a facilitation.'
  );
}

/** Does the facilitation engine drive this conversation for this agent? */
export type EngineDrivenConversationLookup = (
  agentSlug: string,
  channelType: string,
  conversationId: string,
) => boolean;

export interface FacilitatorAgentDeps {
  readonly agentSlug?: string | undefined;
  readonly name?: string | undefined;
  readonly locale?: string | undefined;
  /**
   * #2043 — once the engine receives every message of a conversation
   * (`conversationMessages.subscribe` succeeded), it drives every turn there
   * through `agentTurn`. A turn the CHANNEL starts in that conversation (a
   * mention) would be a second answer to the same message, so it is
   * suppressed here, at the one entry every chat surface shares.
   */
  readonly isEngineDriven?: EngineDrivenConversationLookup;
  readonly log?: (message: string) => void;
}

/**
 * The conversation ids a turn's origin may stand for. Channels fold their own
 * prefix into the session scope (`teams-<id>`, `<channelId>::<id>`), while a
 * subscription is keyed by the channel-native id, so all readings are tried.
 */
export function conversationIdCandidates(input: ChatTurnInput): readonly string[] {
  const scope = input.origin?.scope;
  if (!scope || scope.kind !== 'conversation') return [];
  const raw = scope.conversationId;
  const prefix = `${input.origin!.channelType}-`;
  const separatorAt = raw.indexOf('::');
  return [
    raw,
    ...(raw.startsWith(prefix) ? [raw.slice(prefix.length)] : []),
    ...(separatorAt >= 0 ? [raw.slice(separatorAt + 2)] : []),
  ];
}

type TurnDisposition = 'model' | 'refuse' | 'engine_driven';

export function wrapFacilitatorAgent(inner: ChatAgent, deps: FacilitatorAgentDeps): ChatAgent {
  const refusal = (): string => facilitatorRefusalText(deps);
  const engineDrives = (input: ChatTurnInput): boolean => {
    const { isEngineDriven, agentSlug } = deps;
    if (!isEngineDriven || !agentSlug || !input.origin) return false;
    const channelType = input.origin.channelType;
    try {
      return conversationIdCandidates(input).some((id) => isEngineDriven(agentSlug, channelType, id));
    } catch {
      return false;
    }
  };
  const dispose = (input: ChatTurnInput): TurnDisposition => {
    if (currentEngineTurn() !== undefined) return 'model';
    if (!isGroupTurn(input)) {
      deps.log?.(
        `[facilitator] refused a request for assistance (scope=${input.origin?.scope.kind ?? 'none'})`,
      );
      return 'refuse';
    }
    if (engineDrives(input)) {
      deps.log?.(
        `[facilitator] '${deps.agentSlug ?? '?'}' channel turn suppressed: the facilitation engine drives this conversation`,
      );
      return 'engine_driven';
    }
    return 'model';
  };
  // An engine-driven conversation gets NO text from this turn: the engine
  // answers the same message through its own outbox. An empty answer is what
  // a channel adapter must not post (it should not have started the turn).
  const textFor = (disposition: Exclude<TurnDisposition, 'model'>): string =>
    disposition === 'refuse' ? refusal() : '';
  return {
    async chat(input: ChatTurnInput): Promise<SemanticAnswer> {
      const disposition = dispose(input);
      if (disposition === 'model') return inner.chat(input);
      return toSemanticAnswer({ answer: textFor(disposition), toolCalls: 0, iterations: 0 });
    },
    async *chatStream(
      input: ChatTurnInput,
      observer?: ChatStreamObserver,
    ): AsyncGenerator<ChatStreamEvent> {
      const disposition = dispose(input);
      if (disposition === 'model') {
        yield* inner.chatStream(input, observer);
        return;
      }
      const text = textFor(disposition);
      if (text.length > 0) yield { type: 'text_delta', text };
      yield { type: 'done', answer: text, toolCalls: 0, iterations: 0 };
    },
    ...(inner.holdsContentUntilVerdict !== undefined
      ? { holdsContentUntilVerdict: inner.holdsContentUntilVerdict }
      : {}),
    ...(inner.offeredToolNames ? { offeredToolNames: () => inner.offeredToolNames!() } : {}),
    ...(inner.offeredToolDefinitions
      ? { offeredToolDefinitions: () => inner.offeredToolDefinitions!() }
      : {}),
  };
}
