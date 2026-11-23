/**
 * Spec 2042 §5.14, §6 criterion 29 — "how do you know?".
 *
 * The message body stays uncluttered; the proof of an answer (fact check,
 * system data, colleagues, privacy counts, trace reference) lives in its
 * `AnswerDetails`. A channel with a details element shows them there. Every
 * other route is the agent itself: when the user asks how it knows, the agent
 * needs the details of its previous answer. This wrapper is the kernel's
 * caller of `buildAnswerDetails`: it records the details of each answer the
 * user actually received, per conversation, and hands them to the agent's
 * next turn as a harness note in `extraSystemHint`.
 *
 * Privacy: the note is the `answerDetailsText` projection plus the turn id —
 * statuses, counts and colleagues' names, never a value, a row or a caption.
 * On the API loop `extraSystemHint` is wire content the orchestrator masks
 * through the turn's prompt map; the CLI backend passes it unmasked, which is
 * why the note must never hold a value.
 *
 * A withheld answer (a `system` notice, e.g. the identity guard) records
 * nothing: there is no answer of the agent's to explain.
 */

import {
  answerDetailsText,
  buildAnswerDetails,
  toSemanticAnswer,
  type ChatAgent,
  type ChatStreamEvent,
  type ChatTurnInput,
  type ChatTurnResult,
  type SemanticAnswer,
} from '@omadia/channel-sdk';
import { SYSTEM_SPEAKER } from '@omadia/plugin-api';

/** Conversations whose last answer details are kept per agent (LRU). */
const DEFAULT_MAX_CONVERSATIONS = 1000;

const NOTE_HEADER =
  'Harness record of your previous answer in this conversation (not your words). ' +
  'Use it only when the user asks how you know, where it came from or whether it was checked; ' +
  'say it in your own words, never add it as a footer to other answers.';

/** What the agent is told about its previous answer. */
export function answerDetailsNote(answer: SemanticAnswer): string {
  const details = buildAnswerDetails(answer);
  const lines = answerDetailsText(details, 'en')?.split('\n') ?? [];
  if (details?.verification === undefined) lines.unshift('No fact check settled a claim.');
  // Internal helpers have no name towards users (spec 2042 §5.2): a count.
  const helpers = details?.specialistsInvoked.length ?? 0;
  if (helpers > 0) lines.push(`${String(helpers)} internal helper run(s) worked on it.`);
  if (lines.length === 1) lines.push('No source-system data, colleague or memory was involved.');
  if (answer.turnId) lines.push(`Trace reference: ${answer.turnId}.`);
  return `${NOTE_HEADER}\n${lines.map((l) => `- ${l}`).join('\n')}`;
}

/** Bounded per-conversation memory of the last answer's note. */
export class AnswerDetailsMemory {
  private readonly notes = new Map<string, string>();

  constructor(private readonly maxConversations = DEFAULT_MAX_CONVERSATIONS) {}

  get(scope: string): string | undefined {
    return this.notes.get(scope);
  }

  /** A turn that failed leaves nothing: an older record would be presented
   *  as the previous answer. */
  forget(scope: string): void {
    this.notes.delete(scope);
  }

  record(scope: string, answer: SemanticAnswer): void {
    this.notes.delete(scope);
    if (answer.speaker?.kind === 'system' || answer.systemNotice) return;
    this.notes.set(scope, answerDetailsNote(answer));
    if (this.notes.size > this.maxConversations) {
      const oldest = this.notes.keys().next().value;
      if (oldest !== undefined) this.notes.delete(oldest);
    }
  }
}

function withNote(input: ChatTurnInput, note: string | undefined): ChatTurnInput {
  if (!note) return input;
  const hint = input.extraSystemHint ? `${input.extraSystemHint}\n\n${note}` : note;
  return { ...input, extraSystemHint: hint };
}

/** The `done` event as the result `toSemanticAnswer` projects (same fields). */
function doneAsResult(event: Extract<ChatStreamEvent, { type: 'done' }>): ChatTurnResult {
  const { type: _type, ...rest } = event;
  return rest as ChatTurnResult;
}

function overriding<A extends ChatAgent>(
  inner: A,
  chat: ChatAgent['chat'],
  chatStream: ChatAgent['chatStream'],
): A {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'chat') return chat;
      if (prop === 'chatStream') return chatStream;
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * The recording half, OUTSIDE the identity guard: it sees what the user
 * received, so a withheld answer is recorded as nothing.
 */
export function withAnswerDetailsRecall<A extends ChatAgent>(inner: A, memory: AnswerDetailsMemory): A {
  const chat = async (input: ChatTurnInput): Promise<SemanticAnswer> => {
    try {
      const answer = await inner.chat(input);
      if (input.sessionScope) memory.record(input.sessionScope, answer);
      return answer;
    } catch (err) {
      if (input.sessionScope) memory.forget(input.sessionScope);
      throw err;
    }
  };

  async function* chatStream(
    input: ChatTurnInput,
    observer?: Parameters<ChatAgent['chatStream']>[1],
  ): AsyncGenerator<ChatStreamEvent> {
    const scope = input.sessionScope;
    let done: ChatTurnResult | undefined;
    let speakerIsSystem = false;
    try {
      for await (const event of inner.chatStream(input, observer)) {
        if (scope && event.type === 'done') {
          done = doneAsResult(event);
          // A withheld answer (identity guard, management notice) is not the agent's.
          speakerIsSystem = event.speaker?.kind === 'system' || event.systemNotice !== undefined;
          recordStreamed(scope, done, speakerIsSystem);
        } else if (scope && event.type === 'verifier' && done) {
          // `shadow` mode: the verdict trails `done`.
          done = { ...done, verifier: event.summary };
          recordStreamed(scope, done, speakerIsSystem);
        }
        yield event;
      }
    } finally {
      // Aborted, errored or ended without `done`: no answer to explain.
      if (scope && !done) memory.forget(scope);
    }
  }

  function recordStreamed(scope: string, result: ChatTurnResult, speakerIsSystem: boolean): void {
    const answer = toSemanticAnswer(result);
    memory.record(scope, speakerIsSystem ? { ...answer, speaker: SYSTEM_SPEAKER } : answer);
  }

  return overriding(inner, chat, chatStream);
}

/**
 * The reading half, around the agent loop only (INSIDE the fast lane): a
 * per-turn hint makes the fast lane treat a turn as a system turn, and a
 * fast-lane answer needs no note.
 */
export function withAnswerDetailsNote<A extends ChatAgent>(inner: A, memory: AnswerDetailsMemory): A {
  const noted = (input: ChatTurnInput): ChatTurnInput =>
    withNote(input, input.sessionScope ? memory.get(input.sessionScope) : undefined);
  return overriding(
    inner,
    (input) => inner.chat(noted(input)),
    (input, observer) => inner.chatStream(noted(input), observer),
  );
}
