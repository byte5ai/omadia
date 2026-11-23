/**
 * #2045 — every answer of an agent carries its speaker (spec 2042 INV-4).
 *
 * The outermost wrapper of every agent bundle (`buildOrchestratorForAgent`):
 * whatever produced the answer inside the agent's envelope (model loop, CLI
 * loop, fast lane, facilitator engine, verifier notice), the speaker on it is
 * the agent routing chose, stamped here, never by a model. An answer already
 * marked `system` (a management-layer notice) keeps that speaker.
 */

import type { ChatAgent, ChatStreamEvent, SemanticAnswer } from '@omadia/channel-sdk';
import type { AgentSpeaker, AnswerEmitter } from '@omadia/plugin-api';

/** Marks a wrapped agent so wrapping twice is a no-op. */
const SPEAKER = Symbol.for('omadia.agentSpeaker');
/** The agent's single typed emitter, for paths that publish outside a turn stream. */
const EMITTER = Symbol.for('omadia.agentEmitter');

export function stampAnswer(answer: SemanticAnswer, speaker: AgentSpeaker): SemanticAnswer {
  if (answer.speaker?.kind === 'system') return answer;
  return { ...answer, speaker };
}

export function stampEvent(event: ChatStreamEvent, speaker: AgentSpeaker): ChatStreamEvent {
  if (event.type === 'done') {
    return event.speaker?.kind === 'system' ? event : { ...event, speaker };
  }
  if (event.type === 'error') return { ...event, speaker };
  return event;
}

/** The speaker an agent bundle stamps, when it was built with one. */
export function speakerOf(agent: ChatAgent): AgentSpeaker | undefined {
  return (agent as { readonly [SPEAKER]?: AgentSpeaker })[SPEAKER];
}

/**
 * The emitter of an agent bundle, when it was built with one. A path that
 * publishes this agent's text outside `chat`/`chatStream` (a routine run)
 * emits through it, so the same checks apply.
 */
export function emitterOf(agent: ChatAgent): AnswerEmitter | undefined {
  return (agent as { readonly [EMITTER]?: AnswerEmitter })[EMITTER];
}

/**
 * Wraps `inner` so its `chat` answers and stream `done`/`error` events carry
 * `speaker`. Every other member is forwarded unchanged (a Proxy, so wrapper
 * extras such as the fast lane's stay reachable).
 */
export function withSpeaker<A extends ChatAgent>(inner: A, speaker: AgentSpeaker, emitter?: AnswerEmitter): A {
  if (speakerOf(inner)) return inner;
  const chat = async (input: Parameters<ChatAgent['chat']>[0]): Promise<SemanticAnswer> =>
    stampAnswer(await inner.chat(input), speaker);
  async function* chatStream(
    input: Parameters<ChatAgent['chatStream']>[0],
    observer?: Parameters<ChatAgent['chatStream']>[1],
  ): AsyncGenerator<ChatStreamEvent> {
    for await (const event of inner.chatStream(input, observer)) yield stampEvent(event, speaker);
  }
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === SPEAKER) return speaker;
      if (prop === EMITTER) return emitter;
      if (prop === 'chat') return chat;
      if (prop === 'chatStream') return chatStream;
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
