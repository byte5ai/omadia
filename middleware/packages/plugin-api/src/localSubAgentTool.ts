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
import type { LimitSignal } from './limitSignal.js';
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

/**
 * Structured tool-result with optional postcondition-violation marker
 * (#130). `handle` returns either a bare string (legacy contract — all
 * existing plugins do this) or this shape when the bridge has run the
 * optional `output` Zod schema and detected a mismatch. The verifier
 * picks up `postcondition` and raises a `tool_postcondition` claim that
 * drives the existing correctionPrompt retry loop.
 */
export interface LocalSubAgentToolResult {
  readonly output: string;
  readonly postcondition?: {
    readonly issues: readonly string[];
  };
  /**
   * Optional structured output (Omadia UI, additive). Ignored by the existing
   * `string | LocalSubAgentToolResult` downcast in the sub-agent runner; the
   * canvas orchestrator (PR-9) is the first consumer that threads it.
   */
  readonly structured?: StructuredToolOutput;
  /**
   * Optional runtime limit signal (plugin self-extension, Layer A — additive).
   * A tool that hits a structural wall (row cap, unsupported operation, …)
   * sets this so the orchestrator can surface "this result is bounded — a
   * self-extension could lift it" instead of the agent treating partial data
   * as complete. Ignored by the legacy `string | LocalSubAgentToolResult`
   * downcast. See `./limitSignal.js`.
   */
  readonly limitSignal?: LimitSignal;
}

/**
 * Optional structured-output envelope (Omadia UI, additive). The typed
 * alternative to embedding a `_pendingStructuredPayload` JSON sentinel inside
 * the `output` string: a canvas-aware tool can hand Tier 2 structured data
 * directly. Classic consumers read `output`; canvas-aware consumers read
 * `structured`. `kind` discriminates the payload so the consumer can narrow
 * `data` (e.g. `'structuredPayload'`, `'canvasTree'`).
 */
export interface StructuredToolOutput {
  readonly kind: string;
  readonly data: unknown;
  /** optional human-facing prose (rendered by non-canvas consumers). */
  readonly prose?: string;
}

export interface LocalSubAgentTool {
  spec: LocalSubAgentToolSpec;
  handle(input: unknown): Promise<string | LocalSubAgentToolResult>;
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
