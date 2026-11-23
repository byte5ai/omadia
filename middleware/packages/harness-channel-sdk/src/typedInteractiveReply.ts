/**
 * A typed reply to an answer element (spec 2042 §6 criterion 30, #2086).
 *
 * A channel without buttons shows a `choice`, `topic` or `slots` element as
 * numbered text ({@link renderPlainAnswer}). The person types "2": that is the
 * second option, not the character "2" for the agent's model. The channel
 * remembers the element it just showed per conversation
 * ({@link PendingInteractiveStore}); the next message of that conversation is
 * resolved here, deterministically and without a model, to the text a button
 * click would have echoed. A message that fits no option stays what it was.
 */

import type { CardOption, CardQuestion } from '@omadia/plugin-api';
import type { OutgoingInteractive } from './outgoing.js';
import { parseCardReply } from './questionCardText.js';

type ChoosableInteractive = Extract<OutgoingInteractive, { kind: 'choice' | 'topic' | 'slots' }>;

/** The elements a person answers by picking one of the numbered lines. */
export function isChoosableInteractive(interactive: OutgoingInteractive): interactive is ChoosableInteractive {
  return interactive.kind === 'choice' || interactive.kind === 'topic' || interactive.kind === 'slots';
}

interface Pickable {
  /** What the button click echoes as the person's next message. */
  readonly echo: string;
  readonly option: CardOption;
}

function pickablesOf(interactive: ChoosableInteractive): readonly Pickable[] {
  switch (interactive.kind) {
    case 'choice':
      return interactive.options.map((o, i) => ({ echo: o.value, option: { id: `o${String(i + 1)}`, label: o.label } }));
    case 'topic':
      return interactive.topics.map((t, i) => ({ echo: t.value, option: { id: `o${String(i + 1)}`, label: t.label } }));
    case 'slots':
      // The click of a slot says which slot to book and by which id (Teams'
      // `handleBookSlotClick`); the typed pick says the same.
      return interactive.slots.map((s, i) => ({
        echo: `Bitte diesen Termin buchen: ${s.label}. Nutze book_meeting mit slotId="${s.slotId}" und leite einen sinnvollen Betreff aus dem vorherigen Kontext ab.`,
        option: { id: `o${String(i + 1)}`, label: s.label },
      }));
  }
}

/**
 * The text a button click on this element would have sent, for a typed reply
 * that names one option by its number or its label; `undefined` when the reply
 * names none (then it is an ordinary message).
 */
export function resolveInteractiveReply(interactive: OutgoingInteractive, reply: string): string | undefined {
  if (!isChoosableInteractive(interactive)) return undefined;
  const pickables = pickablesOf(interactive);
  const question: CardQuestion = {
    id: 'pick',
    kind: 'single_choice',
    label: interactive.question,
    options: pickables.map((p) => p.option),
  };
  const parsed = parseCardReply(question, reply);
  if (!parsed.ok || parsed.value.kind !== 'single_choice') return undefined;
  const chosen = parsed.value.optionId;
  return pickables.find((p) => p.option.id === chosen)?.echo;
}

/** An element a channel showed as text and has not seen answered yet. */
export interface PendingInteractive {
  readonly interactive: OutgoingInteractive;
  /** Epoch milliseconds the element was shown. */
  readonly shownAt: number;
}

/** What a channel keeps per conversation. Process-local by default. */
export interface PendingInteractiveStore {
  get(conversationKey: string): PendingInteractive | undefined;
  set(conversationKey: string, pending: PendingInteractive): void;
  clear(conversationKey: string): void;
}

/** A shown element stops being a question after this long. */
export const PENDING_INTERACTIVE_TTL_MS = 24 * 60 * 60 * 1000;

export class InMemoryPendingInteractiveStore implements PendingInteractiveStore {
  readonly #byConversation = new Map<string, PendingInteractive>();
  get(conversationKey: string): PendingInteractive | undefined {
    return this.#byConversation.get(conversationKey);
  }
  set(conversationKey: string, pending: PendingInteractive): void {
    this.#byConversation.set(conversationKey, pending);
  }
  clear(conversationKey: string): void {
    this.#byConversation.delete(conversationKey);
  }
}

/** Remember the element a plain answer just showed (or forget the last one when it showed none). */
export function rememberInteractive(
  store: PendingInteractiveStore,
  conversationKey: string,
  interactive: OutgoingInteractive | undefined,
  now: number = Date.now(),
): void {
  try {
    if (interactive && isChoosableInteractive(interactive)) store.set(conversationKey, { interactive, shownAt: now });
    else store.clear(conversationKey);
  } catch {
    // A store that fails only means a typed reply stays an ordinary message.
  }
}

/**
 * The message the agent should receive for a person's reply: the value of the
 * option they picked when it answers the element last shown in this
 * conversation, else the reply unchanged. The element is spent either way
 * (a picked option is an answer; anything else moves the conversation on).
 */
export function resolveTypedInteractiveReply(
  store: PendingInteractiveStore,
  conversationKey: string,
  reply: string,
  now: number = Date.now(),
): { readonly text: string; readonly resolved: boolean } {
  let pending: PendingInteractive | undefined;
  try {
    pending = store.get(conversationKey);
    if (pending) store.clear(conversationKey);
  } catch {
    pending = undefined;
  }
  if (!pending || now - pending.shownAt > PENDING_INTERACTIVE_TTL_MS) return { text: reply, resolved: false };
  const echoed = resolveInteractiveReply(pending.interactive, reply);
  return echoed === undefined ? { text: reply, resolved: false } : { text: echoed, resolved: true };
}
