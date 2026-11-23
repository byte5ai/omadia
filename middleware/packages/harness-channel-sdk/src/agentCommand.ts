/**
 * #2055 — choosing an agent in plain text (spec 2042 §5.3, criterion 30).
 *
 * In a channel without one identity per agent, a user picks an agent with a
 * command the management layer stores as their selection for this
 * conversation, confirmed by a short `system` notice:
 *
 *   /agent Mira     select Mira for me in this conversation
 *   /agent          clear my selection (the binding or default applies again)
 *   /agents         list the agents available to me here
 *
 * Telegram's `/agent@BotName Mira` form is accepted. The command is the whole
 * message; `/agent` inside a sentence is ordinary text. Channels need no code
 * for it: the ChatAgent the channel resolver returns recognises the command
 * and carries it out (spec 2042 criterion 30).
 */

import type { SystemNotice } from '@omadia/plugin-api';

export type AgentCommand =
  | { readonly kind: 'select'; readonly name: string }
  | { readonly kind: 'clear' }
  | { readonly kind: 'list' };

const COMMAND = /^\s*\/(agents?)(?:@[\w.-]+)?(?:\s+([\s\S]*?))?\s*$/iu;

/** The agent command a message is, or `undefined` for ordinary text. */
export function parseAgentCommand(text: string): AgentCommand | undefined {
  const match = COMMAND.exec(text);
  if (!match) return undefined;
  const verb = match[1]?.toLowerCase();
  const argument = (match[2] ?? '').trim().replace(/^["'“„](.*)["'”“]$/u, '$1').trim();
  if (verb === 'agents') return argument.length === 0 ? { kind: 'list' } : undefined;
  if (argument.length === 0) return { kind: 'clear' };
  return { kind: 'select', name: argument };
}

export interface AgentSelectionContext {
  readonly channelType: string;
  /** The conversation the selection is for. */
  readonly conversationKey: string;
  /** The sender, `user:<id>`. */
  readonly principal: string;
  /** Locale for the notice text (`de`, `en`). */
  readonly locale?: string;
}

/**
 * Carries out an {@link AgentCommand} and returns the `system` notice for the
 * sender (selected, cleared, the list, or why not). Kernel-side; behind the
 * channel resolver's ChatAgent.
 */
export interface AgentSelectionService {
  handle(command: AgentCommand, context: AgentSelectionContext): Promise<SystemNotice>;
}
