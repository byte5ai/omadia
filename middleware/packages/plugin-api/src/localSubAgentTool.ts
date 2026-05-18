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
import type { ToolPIIField } from './piiAnnotation.js';

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
  /**
   * Privacy-Shield v3 (stable-id tokenization, slice 1) — optional PII
   * field annotations. When present, the harness runs a stable-id
   * tokenization pass on the tool's raw result JSON BEFORE serialising
   * to string and BEFORE the NER-based detectors run. Each annotated
   * field gets a stable token of the form `«<TYPE>_<id>»` where
   * `<id>` is the value at `idPath`.
   *
   * Annotations live on the wrapper (not on `spec`) because Anthropic's
   * tool-spec contract rejects unknown fields and PII metadata is a
   * runtime concern, not a model-facing one.
   *
   * See `@omadia/plugin-api`'s `piiAnnotation.ts` for the full schema
   * and path-syntax rationale.
   */
  piiFields?: readonly ToolPIIField[];
}
