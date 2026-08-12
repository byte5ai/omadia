export { activate } from './plugin.js';
export {
  DIAGRAM_TOOL_NAME,
  DiagramTool,
  diagramToolSpec,
  type DiagramBrandMemory,
} from './diagramTool.js';
export { createDiagramsRouter } from './diagramsRouter.js';
export { DiagramService } from './diagramService.js';
export type { DiagramServiceOptions } from './diagramService.js';
export { createKrokiClient } from './krokiClient.js';
export type { KrokiClient } from './krokiClient.js';
export { createTigrisStore, isNotFound } from './tigrisStore.js';
export type { TigrisStore } from './tigrisStore.js';
export { signUrl, verifySig } from './signing.js';
export { buildCacheKey } from './cacheKey.js';
// Only the read-side helpers are public: consumers verify a stored diagram
// carries provenance. The writer (`insertProvenanceChunk`) and the payload
// string (`PROVENANCE_TEXT`) are internal to the render path — not re-exported.
export { hasItxtKeyword, PROVENANCE_KEYWORD } from './pngTextChunk.js';
export {
  ALLOWED_DIAGRAM_KINDS,
  DiagramRenderError,
  DiagramRenderTooLargeError,
  DiagramSourceTooLargeError,
  UnsupportedDiagramKindError,
} from './types.js';
export type { DiagramKind, RenderInput, RenderOutput } from './types.js';
