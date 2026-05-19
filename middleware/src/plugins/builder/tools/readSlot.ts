import { z } from 'zod';

import type { BuilderTool } from './types.js';

/**
 * Read-only counterpart to `fill_slot`. Returns the raw slot source 1:1
 * from `draft.slots[slotKey]` so the agent can inspect what's currently
 * in any slot — for self-debugging, cross-slot consistency checks, or
 * resumed sessions where a previous turn filled the slot. Pure read, no
 * side effects, no tsc gate.
 *
 * On miss, returns the list of currently-filled slot keys so the agent
 * can recover without a second round-trip.
 */

const InputSchema = z
  .object({
    slotKey: z
      .string()
      .min(1, 'slotKey must be non-empty')
      .max(120, 'slotKey too long')
      .regex(
        /^[a-z][a-z0-9-]*$/,
        'slotKey must be kebab-case (lowercase, digits, dashes; start with a letter)',
      ),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

interface OkResult {
  ok: true;
  slotKey: string;
  source: string;
  bytes: number;
}
interface ErrResult {
  ok: false;
  error: string;
  /**
   * Populated on slot-not-found misses. Lists slot keys that ARE filled
   * in the current draft so the agent can pick a real one on the next
   * turn instead of guessing again.
   */
  available?: ReadonlyArray<string>;
}
type Result = OkResult | ErrResult;

export const readSlotTool: BuilderTool<Input, Result> = {
  id: 'read_slot',
  description:
    'Read the current source of a named slot in the draft. Returns the raw ' +
    'string verbatim — no reformat, no trimming. Use this to inspect what ' +
    'you (or a previous turn) wrote into a slot before extending or fixing ' +
    'it, or to cross-check that a symbol referenced from another slot is ' +
    'actually defined. Pure read, no side effects, no tsc gate. On miss the ' +
    'error lists the slot keys that are currently filled.',
  input: InputSchema,
  async run({ slotKey }, ctx) {
    const draft = await ctx.draftStore.load(ctx.userEmail, ctx.draftId);
    if (!draft) {
      return { ok: false, error: `draft ${ctx.draftId} not found for user` };
    }

    const source = draft.slots[slotKey];
    if (source === undefined) {
      const available = Object.keys(draft.slots).sort();
      return {
        ok: false,
        error: `slot '${slotKey}' is not filled in this draft`,
        available,
      };
    }

    return {
      ok: true,
      slotKey,
      source,
      bytes: Buffer.byteLength(source, 'utf8'),
    };
  },
};
