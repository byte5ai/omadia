/**
 * The reference plain-text renderer for an answer (spec 2042 §5.14, #2086).
 *
 * Channels without rich elements (Telegram, Slack, Discord, WhatsApp, iMessage
 * and any custom channel) render an answer as natural text: what a colleague
 * would say. Everything else lives in the structured answer:
 *
 *  - the speaker shows through the channel's own identity, or as a plain name
 *    line only where it would otherwise be unclear ({@link speakerLine});
 *  - a colleague's contribution appears as a plain attribution ("Mira: …");
 *  - a `system` notice is its own text, never under an agent's name;
 *  - a card the channel cannot show degrades to numbered plain text;
 *  - no verifier badge, data chip, consulted footer or length buttons.
 *
 * The AI disclosure line is already part of `answer.text` according to the
 * operator's frequency setting (#2087, `applyAiDisclosure`).
 */

import type { Contribution } from '@omadia/plugin-api';
import type { OutgoingChoiceCard, OutgoingInteractive, SemanticAnswer } from './outgoing.js';
import { speakerLineFor, type SpeakerHistoryStore } from './speakerLine.js';
import { rememberInteractive, type PendingInteractiveStore } from './typedInteractiveReply.js';

export interface PlainAnswerOptions {
  /** The channel shows one identity per agent; no name line then. */
  readonly nativeIdentity: boolean;
  /** Conversation key for the speaker history (name-line decision). */
  readonly conversationKey: string;
  readonly speakerHistory: SpeakerHistoryStore;
  /**
   * Where the element shown as numbered text is kept, so the channel can turn
   * the person's typed "2" into the chosen value ({@link resolveTypedInteractiveReply},
   * criterion 30). Absent: a typed reply is an ordinary message.
   */
  readonly pendingInteractives?: PendingInteractiveStore;
}

function numbered(labels: readonly string[]): string {
  return labels.map((label, index) => `${String(index + 1)}) ${label}`).join('\n');
}

function interactiveText(interactive: OutgoingInteractive): string | undefined {
  switch (interactive.kind) {
    case 'choice':
      return choiceText(interactive);
    case 'topic':
      return [interactive.question, numbered(interactive.topics.map((t) => t.label))].join('\n');
    case 'slots':
      return [interactive.question, numbered(interactive.slots.map((s) => s.label))].join('\n');
    case 'routine_list':
    case 'mcp_input':
      // Folded into `text` by the kernel (`withMcpInputPrompt`) or narrated by
      // the agent; nothing to add.
      return undefined;
  }
}

function choiceText(card: OutgoingChoiceCard): string {
  return [card.question, numbered(card.options.map((o) => o.label))].join('\n');
}

function contributionText(contribution: Contribution): string {
  return `${contribution.speaker.displayName}: ${contribution.text}`;
}

/**
 * The plain text of one answer. A `system` notice renders its own text and
 * nothing else. Records the speaker in `speakerHistory`.
 */
export function renderPlainAnswer(answer: SemanticAnswer, opts: PlainAnswerOptions): string {
  if (answer.speaker?.kind === 'system') {
    return answer.systemNotice?.text ?? answer.text;
  }
  const parts: string[] = [];
  const line = speakerLineFor(opts.speakerHistory, opts.conversationKey, answer.speaker, opts.nativeIdentity);
  const body = answer.text.trim();
  parts.push(line && body.length > 0 ? `${line} ${body}` : body);
  for (const contribution of answer.contributions ?? []) parts.push(contributionText(contribution));
  if (answer.interactive) {
    const text = interactiveText(answer.interactive);
    if (text) parts.push(text);
  }
  if (opts.pendingInteractives) rememberInteractive(opts.pendingInteractives, opts.conversationKey, answer.interactive);
  return parts.filter((p) => p.length > 0).join('\n\n');
}
