/**
 * omadia-canvas-protocol/1.0 — client-side wire types.
 * Server counterpart: byte5ai/omadia middleware/packages/omadia-ui-channel/src/protocol.ts.
 * Where this file and docs/protocol/schema/ disagree, the schema wins.
 */

// ── server → client ──
export interface HandshakeOffer {
  type: 'handshake_offer';
  handshakeId: string;
  protocolVersions: string[];
  opsCatalogVersions: string[];
  serverFeatures?: string[];
}

export interface HandshakeErrorMsg {
  type: 'handshake_error';
  handshakeId: string;
  reason: 'protocol-version-unsupported' | 'ops-catalog-version-unsupported' | 'local-ops-incomplete';
  supported: { protocolVersions: string[]; opsCatalogVersions: string[] };
}

export interface HandshakeAck {
  type: 'handshake_ack';
  handshakeId: string;
  canvasSessionId: string;
}

export interface AgentTextDelta {
  type: 'agent_text_delta';
  forTurn: string;
  text: string;
}

export interface TurnComplete {
  type: 'turn_complete';
  forTurn: string;
}

export interface TurnError {
  type: 'turn_error';
  forTurn?: string;
  message: string;
}

export interface CanvasListEntry {
  sessionId: string;
  title: string;
  color: number;
  tree?: unknown;
  revision?: string;
}

export interface CanvasListMsg {
  type: 'canvas_list';
  canvases: CanvasListEntry[];
}

export type SurfaceEventType =
  | 'surface_snapshot'
  | 'surface_patch'
  | 'surface_data_ref_created'
  | 'surface_data_ref_invalidated'
  | 'surface_action_result'
  | 'surface_local_action'
  | 'surface_error'
  | 'surface_mutation_resolved';

export const SURFACE_EVENT_TYPES: ReadonlySet<string> = new Set<SurfaceEventType>([
  'surface_snapshot',
  'surface_patch',
  'surface_data_ref_created',
  'surface_data_ref_invalidated',
  'surface_action_result',
  'surface_local_action',
  'surface_error',
  'surface_mutation_resolved',
]);

/** Envelope-typed surface event; the full shape is enforced by the Ajv validator, not TS. */
export interface SurfaceEvent {
  type: SurfaceEventType;
  canvasSessionId: string;
  surfaceSeq: number;
  [key: string]: unknown;
}

export type ServerMessage =
  | HandshakeOffer
  | HandshakeErrorMsg
  | HandshakeAck
  | AgentTextDelta
  | TurnComplete
  | TurnError
  | CanvasListMsg
  | SurfaceEvent;

// ── client → server ──
export interface HandshakeSelect {
  type: 'handshake_select';
  handshakeId: string;
  protocolVersion: string;
  opsCatalogVersion: string;
  clientFeatures?: string[];
  localOperations?: string[];
  canvasSessionId?: string;
}

export interface ClientTurn {
  type: 'turn';
  turnId?: string;
  text?: string;
  /** structured UI action (button click, row-click). Carried to Tier 2 via
   *  IncomingTurn.metadata.action — lands server-side with Part B Task B1. */
  action?: { type: string; payload?: unknown };
  target?: unknown;
  viewState?: unknown;
  viewStateTruncated?: boolean;
}

export interface ClientCanvasListGet {
  type: 'canvas_list_get';
}

export type ClientMessage = HandshakeSelect | ClientTurn | ClientCanvasListGet;

const NON_SURFACE_SERVER_TYPES: ReadonlySet<string> = new Set([
  'handshake_offer',
  'handshake_error',
  'handshake_ack',
  'agent_text_delta',
  'turn_complete',
  'turn_error',
  'canvas_list',
]);

/** Tolerant parse of a raw server frame; null for non-JSON / unknown type. */
export function parseServerMessage(raw: string): ServerMessage | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const type = (obj as { type?: unknown }).type;
  if (typeof type !== 'string') return null;
  if (NON_SURFACE_SERVER_TYPES.has(type) || SURFACE_EVENT_TYPES.has(type)) {
    return obj as ServerMessage;
  }
  return null;
}
