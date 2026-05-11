/**
 * Sub-agent tool surface, shared between the kernel-side `LocalSubAgent`
 * runner (which consumes a list of tools) and any plugin that wants to
 * register a tool with that runner. The `harness-verifier` plugin's
 * `createGraphLookupTool` factory is the first plugin-side producer.
 *
 * The `input_schema` shape mirrors what Anthropic's `messages.create({
 * tools })` expects — duplicated here instead of importing the SDK type
 * to keep the seam loose (no plugin-api consumer needs to depend on the
 * Anthropic SDK).
 */
export interface LocalSubAgentToolSpec {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface LocalSubAgentTool {
  spec: LocalSubAgentToolSpec;
  handle(input: unknown): Promise<string>;
}
