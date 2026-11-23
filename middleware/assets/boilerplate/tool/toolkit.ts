import { z } from 'zod';

import type { ToolPIIField } from './types.js';

/**
 * Toolkit = capability → executable handler with a Zod input schema.
 * Each tool entry mirrors 1:1 a capability from manifest.yaml.
 *
 * Kind `tool`: local logic, no external system and no credentials. Switch to
 * the `integration` template the moment a tool needs an authenticated
 * external API.
 *
 * Each tool is registered with the kernel's tool runtime under its `id`
 * (see `registerTools.ts`); `description` is what the calling agent reads.
 * The "when to use this capability" semantics belong in manifest.yaml's
 * `playbook:` block.
 *
 * Zod → JSON Schema: `registerTools.ts` uses `z.toJSONSchema`. Stay with
 * Object, String, Number, Boolean, Enum, Array, Optional, Nullable, Default
 * and Literal; the top-level input must be a `z.object(...)`.
 */

export interface ToolkitOptions {
  log: (...args: unknown[]) => void;
}

export interface ToolDescriptor<I, O> {
  readonly id: string;
  readonly description: string;
  readonly input: z.ZodType<I>;
  /** The fields of the result that hold personal data (names, e-mail
   *  addresses, phone numbers …), e.g.
   *  `[{ path: '[].name', idPath: '[].id', type: 'PERSON' }]` for an array of
   *  rows. Declare every one: the Privacy Shield always masks a declared field
   *  before the result reaches a model. */
  readonly piiFields?: readonly ToolPIIField[];
  run(input: I): Promise<O>;
}

export interface Toolkit {
  readonly tools: readonly ToolDescriptor<unknown, unknown>[];
  close(): Promise<void>;
}

// #region builder:toolkit-impl
// ---------------------------------------------------------------------------
// Tool: {{CAPABILITY_ID}}
// ---------------------------------------------------------------------------
const wordCountInput = z.object({
  text: z.string().min(1).max(20_000),
});

export function createToolkit(opts: ToolkitOptions): Toolkit {
  const tools: ToolDescriptor<unknown, unknown>[] = [
    {
      id: '{{CAPABILITY_ID}}',
      description: '{{CAPABILITY_DESCRIPTION_DE}}',
      input: wordCountInput as z.ZodType<unknown>,
      async run(raw): Promise<{ words: number; characters: number }> {
        const { text } = wordCountInput.parse(raw);
        opts.log('tool:{{CAPABILITY_ID}}', { chars: text.length });
        const words = text.trim().split(/\s+/u).filter((w) => w.length > 0).length;
        return { words, characters: text.length };
      },
    },
  ];

  return {
    tools,
    async close() {},
  };
}
// #endregion
