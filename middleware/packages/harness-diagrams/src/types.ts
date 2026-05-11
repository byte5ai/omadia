/**
 * Public types for the diagram-rendering subsystem. Kept in a separate module
 * so both the service and the Orchestrator tool can import them without pulling
 * in the AWS SDK or undici transitively.
 */

export const ALLOWED_DIAGRAM_KINDS = [
  'mermaid',
  'plantuml',
  'graphviz',
  'vegalite',
] as const;
export type DiagramKind = (typeof ALLOWED_DIAGRAM_KINDS)[number];

export interface RenderInput {
  kind: DiagramKind;
  source: string;
  title?: string;
  /**
   * Optional storage-key reference to a brand-asset blob previously
   * persisted by the TeamsAttachmentStore. When present, the service
   * fetches the bytes from Tigris, base64-inlines them into the spec
   * (replacing the `brand://logo` placeholder), and only then forwards
   * to Kroki. Keys are validated against the known brand-asset prefix
   * to prevent arbitrary blob fetches via this entry-point.
   */
  brandLogoStorageKey?: string;
}

export interface RenderOutput {
  kind: DiagramKind;
  url: string;
  key: string;
  cacheHit: boolean;
  title?: string;
}

/** Thrown when the caller supplied a kind outside the allow-list. */
export class UnsupportedDiagramKindError extends Error {
  constructor(public readonly kind: string) {
    super(
      `Unsupported diagram kind "${kind}". Allowed: ${ALLOWED_DIAGRAM_KINDS.join(', ')}.`,
    );
    this.name = 'UnsupportedDiagramKindError';
  }
}

/** Thrown when the source exceeds the configured safety cap (default 64 KB). */
export class DiagramSourceTooLargeError extends Error {
  constructor(
    public readonly bytes: number,
    public readonly limit: number,
  ) {
    super(
      `Diagram source is ${String(bytes)} bytes; limit is ${String(limit)}. Shorten the diagram or split it.`,
    );
    this.name = 'DiagramSourceTooLargeError';
  }
}

/** Thrown when Kroki produced a PNG larger than Teams will accept. */
export class DiagramRenderTooLargeError extends Error {
  constructor(
    public readonly bytes: number,
    public readonly limit: number,
  ) {
    super(
      `Rendered PNG is ${String(bytes)} bytes; Teams cap is ${String(limit)}. Simplify the diagram or lower its complexity.`,
    );
    this.name = 'DiagramRenderTooLargeError';
  }
}

/** Thrown for upstream Kroki failures (non-2xx, timeout, network). */
export class DiagramRenderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'DiagramRenderError';
  }
}
