import { z } from 'zod';

import type { BuilderTool } from './types.js';

const InputSchema = z.object({}).strict();

type Input = z.infer<typeof InputSchema>;

interface Result {
  ok: true;
  tools: string[];
}

export const listCatalogToolsTool: BuilderTool<Input, Result> = {
  id: 'list_catalog_tools',
  description:
    'Return all built-in catalog tool names (orchestrator-native + reserved-' +
    'prefix matches). Call before naming a new tool to avoid shadowing a ' +
    'platform tool.',
  input: InputSchema,
  async run(_input, ctx) {
    const tools = [...ctx.catalogToolNames()].sort();
    return { ok: true, tools };
  },
};
