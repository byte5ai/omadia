import { z } from 'zod';

import type { BuilderTool } from './types.js';

/**
 * Returns the reference-implementation catalog so the LLM can pick the
 * closest existing agent / integration / template before reading files.
 *
 * The catalog is configured at boot via `BuilderToolContext.referenceCatalog`.
 * This tool just snapshots the keys + descriptions — it never touches the
 * filesystem.
 */

const InputSchema = z.object({}).strict();
type Input = z.infer<typeof InputSchema>;

interface Result {
  ok: true;
  references: ReadonlyArray<{ name: string; description: string }>;
  defaultName: string | null;
}

export const listReferencesTool: BuilderTool<Input, Result> = {
  id: 'list_references',
  description:
    'List the available reference packages the BuilderAgent can read via ' +
    'read_reference. Each entry has a `name` (use that as `read_reference`\'s ' +
    '`name` argument) and a short description. Pick the one closest to the ' +
    'agent you are designing — an HTTP-integration agent should reference ' +
    'an existing integration package, not just the SEO-analyst.',
  input: InputSchema,
  async run(_input, ctx) {
    const keys = Object.keys(ctx.referenceCatalog);
    return {
      ok: true,
      references: keys.map((k) => {
        const entry = ctx.referenceCatalog[k];
        return {
          name: k,
          description: entry?.description ?? '',
        };
      }),
      defaultName: keys[0] ?? null,
    };
  },
};
