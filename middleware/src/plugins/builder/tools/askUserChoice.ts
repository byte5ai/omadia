import { z } from 'zod';

import type { BuilderTool } from './types.js';

/**
 * `ask_user_choice` — surface a smart-card with 2-4 buttons and wait
 * for the operator to pick one. Used by the native issue-reporting
 * flow to confirm Workaround / Pause / Skip after a platform-issue
 * triage, but generic enough to host future choice dialogs.
 *
 * The tool returns `{ ok: true, value }` once the operator clicks a
 * button. If the operator dismisses the card or the choice times out,
 * it returns `{ ok: false, reason }` so the agent can branch on
 * cancellation without crashing the turn.
 */

const ChoiceOptionSchema = z
  .object({
    value: z.string().min(1).max(64),
    label: z.string().min(1).max(80),
    description: z.string().max(200).optional(),
  })
  .strict();

const InputSchema = z
  .object({
    question: z.string().min(1).max(280),
    options: z.array(ChoiceOptionSchema).min(2).max(4),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

type Result =
  | { ok: true; value: string }
  | { ok: false; reason: 'cancelled' | 'timeout' | 'unavailable' };

export const askUserChoiceTool: BuilderTool<Input, Result> = {
  id: 'ask_user_choice',
  description:
    'Show the operator a smart-card with 2 to 4 buttons and wait for them ' +
    'to pick one. Use when the agent has identified a fork in the road that ' +
    'only the operator can answer (e.g. "report this platform bug as an ' +
    'issue, pause until it is fixed, or move on without reporting"). Do NOT ' +
    'use as a substitute for chat questions — chat is cheaper and faster ' +
    'when the operator can express the answer in plain language. The values ' +
    'in `options[].value` are the strings the agent will read back; choose ' +
    'short, stable identifiers.',
  input: InputSchema,
  async run(input, ctx) {
    if (!ctx.userChoice) {
      return { ok: false, reason: 'unavailable' };
    }
    const { result } = ctx.userChoice.create({
      draftId: ctx.draftId,
      question: input.question,
      options: input.options,
    });
    const outcome = await result;
    if (outcome.ok) return { ok: true, value: outcome.value };
    return { ok: false, reason: outcome.reason === 'timeout' ? 'timeout' : 'cancelled' };
  },
};
