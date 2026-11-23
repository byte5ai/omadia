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
 *   - a turn from a GROUP conversation does, when the facilitation engine is
 *     usable: that is where a person asks the facilitator to start, and the
 *     model only has the engine's tools and the neutrality contract to answer
 *     with. Without a usable engine it gets a fixed "not set up" answer;
 *   - everything else — a personal chat, the web chat, an API call, a
 *     workflow step, a turn whose origin nobody stated — gets a fixed,
 *     friendly refusal that says what the facilitator does.
 *
 * Fail-closed in the direction that matters: a turn that cannot be placed in
 * a group is treated as a private request for help. The refusal is not
 * logged as a session and not captured; nothing was learned.
 */

import { conversationIdCandidates } from './channelConversationId.js';
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  toSemanticAnswer,
  type AiDisclosure,
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

/**
 * A turn from a group conversation, by the platform's own statement.
 *
 * Not inferred: a `conversation` scope is what a 1:1 looks like on most
 * channels, and a personal Teams chat without a user id falls back to it.
 * Only `origin.conversationType === 'group'` (or the `group` scope kind)
 * counts; unknown is treated as a private request.
 */
export function isGroupTurn(input: ChatTurnInput): boolean {
  const origin = input.origin;
  if (!origin) return false;
  if (origin.scope.kind === 'group') return true;
  return origin.scope.kind === 'conversation' && origin.conversationType === 'group';
}

/** Said in a group when facilitation is not set up on the instance (spec
 *  2043 §0): the facilitator says so and does nothing else. */
export function facilitationNotSetUpText(opts: {
  readonly name?: string | undefined;
  readonly locale?: string | undefined;
}): string {
  const name = opts.name?.trim();
  if (opts.locale?.toLowerCase().startsWith('de')) {
    return (
      `${name ? `Ich bin ${name}. ` : ''}Moderationen sind auf dieser Instanz noch nicht eingerichtet, ` +
      'deshalb kann ich hier gerade nichts tun. Bitte wendet euch an eure Administration.'
    );
  }
  return (
    `${name ? `I am ${name}. ` : ''}Facilitation is not set up on this instance yet, ` +
    'so there is nothing I can do here right now. Please contact your administrator.'
  );
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

/**
 * The kernel's statement for a turn a channel started in a group where no
 * facilitation runs yet. Every sentence is something the kernel checked
 * before it let the turn reach the model (see `dispose`).
 */
export function groupTurnStatement(channelType: string | undefined): string {
  return [
    '# Where this message comes from (stated by the platform)',
    `- A GROUP conversation${channelType ? ` on ${channelType}` : ''}. You are present in it under your own identity; it is not a private chat.`,
    '- The facilitation engine is set up, and no facilitation is running in this conversation yet.',
    '- If the group asks for a facilitation, set it up here with your tools. Never ask to be added to another chat first.',
    '- You keep no memory between messages of this conversation: the next message reaches you without this one and without your answer. A setup you only describe is lost. Record it with your tools in this same turn, then ask the group to confirm or adjust.',
  ].join('\n');
}

/** Does the facilitation engine drive this conversation for this agent? */
export type EngineDrivenConversationLookup = (
  agentSlug: string,
  channelType: string,
  conversationId: string,
) => boolean;

/** What the kernel answers the orchestrator about a facilitator at turn
 *  time (service `facilitatorConversations`). */
export interface FacilitatorRuntimeLookup {
  isEngineDriven: EngineDrivenConversationLookup;
  isEngineUsable(agentSlug: string): boolean;
  /** How many messages went out to this conversation as the agent's OWN
   *  identity so far (a counter, only ever compared with itself). Optional:
   *  an older kernel does not count. */
  ownPostCount?: OwnPostCountLookup;
  /** #2089 — see {@link PrivateTurnLookup}. Optional: an older kernel
   *  answers every private request with the fixed refusal. */
  privateTurn?: PrivateTurnLookup;
  /** #2089 — see {@link AddressedTurnLookup}. Optional: an older kernel lets
   *  the model answer every group turn the engine does not drive. */
  addressedTurn?: AddressedTurnLookup;
}

/**
 * #2089 — a group turn in a conversation the engine does not drive, where a
 * process of the agent may still listen for messages that address it (a
 * facilitation in follow-up). `true`: a process takes the message and the
 * turn stays silent; `false`: the agent's ordinary turn answers.
 *
 * `{ answer }` (#2089, a link request in a conversation no process reads,
 * spec 2043 §5.3): a process takes the message and this fixed text is the
 * turn's answer (for example the one short refusal of a link).
 */
export type AddressedTurnLookup = (
  agentSlug: string,
  message: {
    channelType: string;
    conversationIds: readonly string[];
    principalId: string;
    text: string;
    messageId?: string;
  },
) => Promise<boolean | { readonly answer: string }>;

/**
 * #2089 — a private message to the facilitator from a person who takes part
 * in one of its running processes: the answer of that process, or
 * `undefined` when none takes the message (then the fixed refusal is given).
 */
export type PrivateTurnLookup = (
  agentSlug: string,
  message: { channelType: string; principalId: string; text: string; replyToMessageId?: string },
) => Promise<string | undefined>;

export type OwnPostCountLookup = (
  agentSlug: string,
  channelType: string,
  conversationId: string,
) => number;

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
  /**
   * Can the facilitation engine run a facilitation for this agent right now
   * (bound, trusted, active, reporting itself available, granted to the
   * agent)? Absent or `false` = no: a group turn then gets the fixed "not set
   * up" answer and never reaches the model, which would have no tool to act
   * with.
   */
  readonly isEngineUsable?: (agentSlug: string) => boolean;
  /**
   * The engine posts as the facilitator. When it did so DURING a turn the
   * channel started (the mention that opens a facilitation: the engine posts
   * the handshake from inside the tool call), the turn's own answer would be
   * a second message about the same thing, in the model's words instead of
   * the engine's. That answer is dropped. A turn in which the engine posted
   * nothing (the setup is still being agreed) keeps its answer.
   */
  readonly ownPostCount?: OwnPostCountLookup;
  /**
   * #2089 — asked for a request that is not from a group, before the fixed
   * refusal: a participant of a running facilitation gets that
   * facilitation's status in the private chat (spec 2043 §5.3).
   */
  readonly privateTurn?: PrivateTurnLookup;
  /**
   * #2089 — asked for a group turn the engine does not drive, before the
   * model runs: a process that listens for messages addressing the agent
   * (follow-up) may take the message. Then the turn stays silent, exactly as
   * in an engine-driven conversation, and the process answers.
   */
  readonly addressedTurn?: AddressedTurnLookup;
  /**
   * The AI disclosure of this agent's turn answers (resolution and first-turn
   * fold of its orchestrator). The fixed texts below never reach the model or
   * the orchestrator's output path, so without this they were the one kind of
   * turn answer that went out unmarked. Absent = the text as it is.
   */
  readonly disclose?: (
    answer: string,
    input: ChatTurnInput,
  ) => { readonly answer: string; readonly aiDisclosure?: AiDisclosure };
  readonly log?: (message: string) => void;
}

type TurnDisposition = 'model' | 'refuse' | 'engine_driven' | 'not_set_up';

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
  const engineUsable = (): boolean => {
    try {
      return deps.agentSlug !== undefined && deps.isEngineUsable?.(deps.agentSlug) === true;
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
    if (!engineUsable()) {
      deps.log?.(
        `[facilitator] '${deps.agentSlug ?? '?'}' answered "not set up": no usable facilitation engine`,
      );
      return 'not_set_up';
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
    disposition === 'refuse'
      ? refusal()
      : disposition === 'not_set_up'
        ? facilitationNotSetUpText(deps)
        : '';
  /** A fixed text as a turn answer: marked like every other answer of this
   *  agent. An empty text (engine-driven) stays empty and unmarked. */
  const fixedAnswer = (
    disposition: Exclude<TurnDisposition, 'model'>,
    input: ChatTurnInput,
  ): { readonly answer: string; readonly aiDisclosure?: AiDisclosure } => disclosed(textFor(disposition), input);
  /** A fixed text as this agent's answer, marked like every other one. */
  const disclosed = (
    answer: string,
    input: ChatTurnInput,
  ): { readonly answer: string; readonly aiDisclosure?: AiDisclosure } => {
    if (answer.length === 0 || !deps.disclose) return { answer };
    try {
      return deps.disclose(answer, input);
    } catch (err) {
      deps.log?.(
        `[facilitator] AI disclosure of a fixed answer failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { answer };
    }
  };
  /**
   * What the kernel established before the model runs, said to the model.
   * Without it the model has to guess where it is, and in the integration
   * run it once answered a group mention with "this is a 1:1 chat, add me to
   * a group first" and started nothing.
   */
  const withGroupStatement = (input: ChatTurnInput): ChatTurnInput => {
    if (currentEngineTurn() !== undefined) return input;
    const statement = groupTurnStatement(input.origin?.channelType);
    return {
      ...input,
      extraSystemHint: input.extraSystemHint ? `${statement}\n\n${input.extraSystemHint}` : statement,
    };
  };
  const ownPosts = (input: ChatTurnInput): number => {
    const { ownPostCount, agentSlug } = deps;
    if (!ownPostCount || !agentSlug || !input.origin) return 0;
    const channelType = input.origin.channelType;
    try {
      return conversationIdCandidates(input).reduce((sum, id) => sum + ownPostCount(agentSlug, channelType, id), 0);
    } catch {
      return 0;
    }
  };
  /** Only a turn the CHANNEL started: an engine turn's text is the engine's
   *  to post or not. */
  const watchesEnginePosts = (): boolean => currentEngineTurn() === undefined;
  const enginePostedSince = (input: ChatTurnInput, before: number): boolean => {
    if (ownPosts(input) <= before) return false;
    deps.log?.(
      `[facilitator] '${deps.agentSlug ?? '?'}' turn answer dropped: the facilitation engine posted in this turn`,
    );
    return true;
  };
  /** The answer of a running process to a private message, marked like every
   *  other answer of this agent; `undefined` when no process takes it. */
  const privateAnswer = async (
    input: ChatTurnInput,
  ): Promise<{ readonly answer: string; readonly aiDisclosure?: AiDisclosure } | undefined> => {
    const { privateTurn, agentSlug } = deps;
    const principal = input.origin?.principal;
    if (!privateTurn || !agentSlug || !input.origin || principal?.kind !== 'user') return undefined;
    let answer: string | undefined;
    const replyTo = input.origin.replyToMessageId;
    try {
      answer = await privateTurn(agentSlug, {
        channelType: input.origin.channelType,
        principalId: principal.userId,
        text: input.userMessage,
        ...(typeof replyTo === 'string' && replyTo.length > 0 ? { replyToMessageId: replyTo } : {}),
      });
    } catch (err) {
      deps.log?.(`[facilitator] private message lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    if (answer === undefined || answer.length === 0) return undefined;
    deps.log?.(`[facilitator] '${agentSlug}' answered a participant's private message from a running process`);
    if (!deps.disclose) return { answer };
    try {
      return deps.disclose(answer, input);
    } catch {
      return { answer };
    }
  };
  /** Does a process of the agent take this group turn? Only asked for a turn
   *  the channel started and the model would otherwise answer. */
  const takenByAProcess = async (input: ChatTurnInput): Promise<false | { readonly answer?: string }> => {
    const { addressedTurn, agentSlug } = deps;
    const principal = input.origin?.principal;
    if (!addressedTurn || !agentSlug || !input.origin || principal?.kind !== 'user') return false;
    if (currentEngineTurn() !== undefined) return false;
    try {
      const messageId = input.origin.messageId;
      const taken = await addressedTurn(agentSlug, {
        channelType: input.origin.channelType,
        conversationIds: conversationIdCandidates(input),
        principalId: principal.userId,
        text: input.userMessage,
        ...(typeof messageId === 'string' && messageId.length > 0 ? { messageId } : {}),
      });
      if (taken) {
        deps.log?.(
          `[facilitator] '${agentSlug}' channel turn suppressed: a process of the agent takes the message that addresses it`,
        );
      }
      if (typeof taken === 'object' && taken !== null && typeof taken.answer === 'string') {
        return taken.answer.length > 0 ? { answer: taken.answer } : {};
      }
      return taken === true ? {} : false;
    } catch (err) {
      deps.log?.(`[facilitator] addressed message lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };
  const disposeTurn = async (
    input: ChatTurnInput,
  ): Promise<{ disposition: TurnDisposition; processAnswer?: string }> => {
    const disposition = dispose(input);
    if (disposition !== 'model') return { disposition };
    const taken = await takenByAProcess(input);
    if (taken === false) return { disposition };
    return { disposition: 'engine_driven', ...(taken.answer !== undefined ? { processAnswer: taken.answer } : {}) };
  };
  const answerOf = async (
    disposition: Exclude<TurnDisposition, 'model'>,
    processAnswer: string | undefined,
    input: ChatTurnInput,
  ): Promise<{ readonly answer: string; readonly aiDisclosure?: AiDisclosure }> => {
    if (processAnswer !== undefined) return disclosed(processAnswer, input);
    return (disposition === 'refuse' ? await privateAnswer(input) : undefined) ?? fixedAnswer(disposition, input);
  };
  return {
    async chat(input: ChatTurnInput): Promise<SemanticAnswer> {
      const { disposition, processAnswer } = await disposeTurn(input);
      if (disposition === 'model') {
        const watch = watchesEnginePosts();
        const before = watch ? ownPosts(input) : 0;
        const answer = await inner.chat(withGroupStatement(input));
        return watch && enginePostedSince(input, before) ? { ...answer, text: '' } : answer;
      }
      const fixed = await answerOf(disposition, processAnswer, input);
      return {
        ...toSemanticAnswer({ answer: fixed.answer, toolCalls: 0, iterations: 0 }),
        ...(fixed.aiDisclosure ? { aiDisclosure: fixed.aiDisclosure } : {}),
      };
    },
    async *chatStream(
      input: ChatTurnInput,
      observer?: ChatStreamObserver,
    ): AsyncGenerator<ChatStreamEvent> {
      const { disposition, processAnswer } = await disposeTurn(input);
      if (disposition === 'model') {
        const watch = watchesEnginePosts();
        const before = watch ? ownPosts(input) : 0;
        let streamed = 0;
        for await (const event of inner.chatStream(withGroupStatement(input), observer)) {
          if (event.type === 'text_delta') streamed += event.text.length;
          else if (event.type === 'text_retract') streamed = Math.max(0, streamed - event.chars);
          else if (event.type === 'done' && watch && enginePostedSince(input, before)) {
            if (streamed > 0) yield { type: 'text_retract', chars: streamed };
            yield { ...event, answer: '' };
            continue;
          }
          yield event;
        }
        return;
      }
      const fixed = await answerOf(disposition, processAnswer, input);
      if (fixed.answer.length > 0) yield { type: 'text_delta', text: fixed.answer };
      yield {
        type: 'done',
        answer: fixed.answer,
        toolCalls: 0,
        iterations: 0,
        ...(fixed.aiDisclosure ? { aiDisclosure: fixed.aiDisclosure } : {}),
      };
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
