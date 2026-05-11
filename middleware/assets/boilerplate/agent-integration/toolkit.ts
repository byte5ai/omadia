import { z } from 'zod';
import type { Client, SearchResult } from './client.js';

/**
 * Toolkit = Capability → ausführbarer Handler mit Zod-Input-Schema.
 * Jeder Tool-Eintrag spiegelt 1:1 eine Capability aus manifest.yaml.
 *
 * Tool-Name-Derivation (Runtime, NICHT hier):
 *   de.byte5.agent.<slug>  →  query_<slug_mit_underscores>
 * Die DomainTool-Description wird zur Laufzeit aus plugin.description +
 * playbook.when_to_use + playbook.not_for zusammengesetzt. Deshalb gehört
 * die "wann-nutze-mich"-Semantik ins Manifest, NICHT in den Tool-Code.
 *
 * Zod-Support der Bridge (Claude-Tool-Schema-Generator):
 *   OK:        Object, String (.url/.email/.uuid/.min/.max/.regex),
 *              Number (.int/.min/.max), Boolean, Enum, Array,
 *              Optional, Nullable, Default, Literal, Effects
 *   FALLBACK:  Union, DiscriminatedUnion, Intersection, Record, Tuple → {}
 *              (Claude bekommt kein strukturiertes Schema → schwache UX).
 *   Regel:     Bei den unterstützten Typen bleiben.
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
