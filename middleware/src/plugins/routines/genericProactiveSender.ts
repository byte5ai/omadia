import type { SemanticAnswer } from '@omadia/channel-sdk';

import type { ProactiveSender } from './proactiveSender.js';

/**
 * Adapt a plain `(conversationRef, message) => Promise<void>` function
 * into the `ProactiveSender` shape the routines runner consumes. Lets
 * channel plugins / kernel wiring contribute proactive senders without
 * having to subclass or implement the interface boilerplate inline.
 *
 * Typical wiring for Teams:
 *
 * ```ts
 * import { CloudAdapter } from 'botbuilder';
 * const adapter: CloudAdapter = …;            // long-lived BF adapter
 * const appId: string = …;                    // Bot Framework app id
 *
 * const teamsSender = createProactiveSender('teams', async (ref, msg) => {
 *   await adapter.continueConversationAsync(
 *     appId,
 *     ref as Partial<ConversationReference>,
 *     async (ctx) => {
 *       await ctx.sendActivity({ type: 'message', text: msg.text });
 *     },
 *   );
 * });
 * senderRegistry.register(teamsSender);
 * ```
 *
 * The wrapper does not interpret `conversationRef` — it's the channel
 * adapter's responsibility to know its own wire shape. Likewise it does
 * not translate `SemanticAnswer.text` to anything richer; channels that
 * want adaptive cards / attachments map them inside their own send-fn.
 */
export function createProactiveSender(
  channel: string,
  send: (
    conversationRef: unknown,
    message: SemanticAnswer & { cardBody?: readonly unknown[] },
    routine?: { id: string; name: string; cron: string },
  ) => Promise<void>,
): ProactiveSender {
  return {
    channel,
    async send(opts) {
      // Phase C.6 — fold the optional Adaptive Card body items into the
      // message envelope so channel adapters can read both `text`
      // (markdown fallback) and `cardBody` (rich-card primitives) from
      // a single object, without us teaching the integration shim to
      // forward a third positional argument.
      const message =
        opts.cardBody !== undefined
          ? { ...opts.message, cardBody: opts.cardBody }
          : opts.message;
      await send(opts.conversationRef, message, opts.routine);
    },
  };
}
