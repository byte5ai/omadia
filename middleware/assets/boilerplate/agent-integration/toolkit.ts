import { z } from 'zod';
import type { Client, SearchResult } from './client.js';

/**
 * Toolkit = capability → executable handler with a Zod input schema.
 * Each tool entry mirrors 1:1 a capability from manifest.yaml.
 *
 * Tool-name derivation (runtime, NOT here):
 *   de.byte5.agent.<slug>  →  query_<slug_with_underscores>
 * The DomainTool description is composed at runtime from plugin.description +
 * playbook.when_to_use + playbook.not_for. Therefore the
 * "when-to-use-me" semantics belong in the manifest, NOT in the tool code.
 *
 * Zod support of the bridge (Claude tool-schema generator):
 *   OK:        Object, String (.url/.email/.uuid/.min/.max/.regex),
 *              Number (.int/.min/.max), Boolean, Enum, Array,
 *              Optional, Nullable, Default, Literal, Effects
 *   FALLBACK:  Union, DiscriminatedUnion, Intersection, Record, Tuple → {}
 *              (Claude gets no structured schema → weak UX).
 *   Rule:      Stay within the supported types.
 */

export interface ToolkitOptions {
  client: Client;
  log: (...args: unknown[]) => void;
}

export interface ToolDescriptor<I, O> {
  readonly id: string;
  readonly description: string;
  readonly input: z.ZodType<I>;
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
const searchInput = z.object({
  query: z.string().min(1).max(500),
});

export function createToolkit(opts: ToolkitOptions): Toolkit {
  const tools: ToolDescriptor<unknown, unknown>[] = [
    {
      id: '{{CAPABILITY_ID}}',
      description: '{{CAPABILITY_DESCRIPTION_DE}}',
      input: searchInput as z.ZodType<unknown>,
      async run(raw): Promise<SearchResult[]> {
        const { query } = searchInput.parse(raw);
        opts.log('tool:{{CAPABILITY_ID}}', { query });
        return opts.client.search(query);
      },
    },
  ];

  return {
    tools,
    async close() {
      await opts.client.dispose();
    },
  };
}
// #endregion
