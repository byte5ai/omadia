/**
 * omadia-canvas-protocol/1.0 — the wire messages the Tier-1 server channel
 * exchanges with the canvas client over the WebSocket.
 *
 *   server → client:  handshake_offer · handshake_error · handshake_ack,
 *                     then the surface_* event family (forwarded 1:1 from
 *                     Tier 2 — defined in @omadia/channel-sdk as
 *                     SurfaceStreamEvent, NOT re-declared here) plus the
 *                     agent_text_delta / turn_complete / turn_error envelopes
 *                     that fold the non-surface stream events for the client.
 *   client → server:  handshake_select, then `turn`.
 *
 * Only the channel-owned envelopes + the client-input messages live here; the
 * versioned canvas tree / surface-event shapes are the SDK's.
 *
 * Orchestrator-internal stream events (`iteration_start`, `tool_use`,
 * `tool_result`, `tool_progress`, `sub_*`, `verifier`, `turn_annotation`) are
 * deliberately NOT forwarded — they are server telemetry, not canvas wire. Only
 * `surface_*` (1:1), `text_delta` (→ `agent_text_delta`), and `error`
 * (→ `turn_error`) cross to the client, terminated by `turn_complete`.
 */

// ───────────────────────── server → client ─────────────────────────

export interface HandshakeOffer {
  type: 'handshake_offer';
  handshakeId: string;
  protocolVersions: string[];
  opsCatalogVersions: string[];
  serverFeatures?: string[];
}

export type HandshakeErrorReason =
  | 'protocol-version-unsupported'
  | 'ops-catalog-version-unsupported'
  | 'local-ops-incomplete';

export interface HandshakeError {
  type: 'handshake_error';
  handshakeId: string;
  reason: HandshakeErrorReason;
  supported: { protocolVersions: string[]; opsCatalogVersions: string[] };
}

export interface HandshakeAck {
  type: 'handshake_ack';
  handshakeId: string;
  /** the resolved canvas session id (client-supplied or server-minted) */
  canvasSessionId: string;
}

/** A non-surface stream event (agent prose) folded for the canvas client. */
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

/** One entry of the per-USER canvas registry (multi-canvas sidebar). The
 *  registry is keyed by the authenticated subject server-side, so every
 *  Omadia UI install of the same user sees the same canvas list. */
export interface CanvasListEntry {
  sessionId: string;
  title: string;
  color: number;
  /** last server-authoritative tree — materialises the canvas on app start.
   *  Stored opaquely (the CLIENT whitelist-validates before rendering). */
  tree?: unknown;
  revision?: string;
}

/** server → client: the user's persisted canvas list (answer to canvas_list_get). */
export interface CanvasList {
  type: 'canvas_list';
  canvases: CanvasListEntry[];
}

// ───────────────────────── client → server ─────────────────────────

export interface HandshakeSelect {
  type: 'handshake_select';
  handshakeId: string;
  protocolVersion: string;
  opsCatalogVersion: string;
  clientFeatures?: string[];
  /** the catalog ops this client actually implements (Tier-2 Class-B routing
   *  truth). Not enforced for completeness in v1 — Tier 2 degrades gracefully. */
  localOperations?: string[];
  /** optional — the client persists this across reconnects to resume a canvas;
   *  absent → the server mints one and returns it in handshake_ack. */
  canvasSessionId?: string;
}

export interface ClientTurn {
  type: 'turn';
  /** optional client-supplied correlation id; the server mints one if absent */
  turnId?: string;
  text?: string;
  /** structured UI action (button click, row-click); shape-validated by the
   *  channel, semantically by Tier 2. Rides `IncomingTurn.metadata.action`
   *  until the SDK grows a typed field (protocol 1.0 §5.1 feedback). */
  action?: unknown;
  /** a `TargetRef` (canvas/container/element/…); validated downstream by Tier 2. */
  target?: unknown;
  /** a `CanvasViewState`; passed through for referential continuity. */
  viewState?: unknown;
  viewStateTruncated?: boolean;
}

/** client → server: fetch the user's persisted canvas list (app start sync). */
export interface ClientCanvasListGet {
  type: 'canvas_list_get';
}

/** client → server: replace the user's persisted canvas list. */
export interface ClientCanvasListPut {
  type: 'canvas_list_put';
  canvases?: unknown;
}

/** client → server: deterministic refresh (protocol 1.1 additive, omadia-ui#5).
 *  Carries the client's CURRENT tree + revision; the server re-fetches the
 *  data behind the tree's containers and answers with ordinary surface_patch
 *  events whose first publish per container REPLACES the stale rows. No new
 *  view is composed. Completion signals via turn_complete/turn_error. */
export interface ClientCanvasRefresh {
  type: 'canvas_refresh';
  /** optional client-supplied correlation id; the server mints one if absent */
  turnId?: string;
  /** the revision the client's tree is at — patches build on it */
  basedOnRevision?: unknown;
  /** the client's current canvas tree (server is stateless cross-turn in v1) */
  currentTree?: unknown;
  /** optional containerId — refresh a single table/chart instead of all */
  scope?: unknown;
}

/** client → server: abort the named in-flight turn (omadia-ui#13, additive).
 *  The channel stops consuming the orchestrator stream immediately and
 *  answers `turn_error { forTurn, message: 'aborted' }`; surface events
 *  already emitted stay applied. Stale/unknown ids are a no-op. */
export interface ClientTurnAbort {
  type: 'turn_abort';
  forTurn?: unknown;
}

export type ClientMessage =
  | HandshakeSelect
  | ClientTurn
  | ClientCanvasListGet
  | ClientCanvasListPut
  | ClientCanvasRefresh
  | ClientTurnAbort;

/**
 * The surface_* event types forwarded 1:1 to the canvas client — the runtime
 * mirror of the SDK's `SurfaceStreamEvent` union. Forwarding is gated on this
 * explicit set (not a `surface_` prefix) so an unknown / internal event can
 * never masquerade as a protocol surface frame.
 */
export const SURFACE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'surface_snapshot',
  'surface_patch',
  'surface_data_ref_created',
  'surface_data_ref_invalidated',
  'surface_action_result',
  'surface_local_action',
  'surface_error',
  'surface_mutation_resolved',
]);

/**
 * Tolerant parse of a raw client frame. Returns null for non-JSON, non-object,
 * or an unrecognised `type` — the connection drops those silently rather than
 * trusting arbitrary input.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const type = (obj as { type?: unknown }).type;
  if (
    type === 'handshake_select' ||
    type === 'turn' ||
    type === 'canvas_list_get' ||
    type === 'canvas_list_put' ||
    type === 'canvas_refresh' ||
    type === 'turn_abort'
  ) {
    return obj as ClientMessage;
  }
  return null;
}

/** Whitelist-sanitise a client-supplied canvas list (max 50 entries). */
export function sanitizeCanvasList(raw: unknown): CanvasListEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (e): e is Record<string, unknown> => typeof e === 'object' && e !== null && !Array.isArray(e),
    )
    .filter((e) => typeof e['sessionId'] === 'string' && (e['sessionId'] as string).length > 0)
    .slice(0, 50)
    .map((e) => {
      // tree blobs are size-capped (256 KB serialised) — oversized ones are
      // dropped silently; the canvas then cold-starts like before.
      let tree: unknown;
      if (typeof e['tree'] === 'object' && e['tree'] !== null) {
        try {
          if (JSON.stringify(e['tree']).length <= 262_144) tree = e['tree'];
        } catch {
          /* circular / unserialisable → drop */
        }
      }
      return {
        sessionId: (e['sessionId'] as string).slice(0, 128),
        title: typeof e['title'] === 'string' ? (e['title'] as string).slice(0, 64) : '',
        color:
          typeof e['color'] === 'number' && Number.isInteger(e['color'])
            ? Math.min(Math.max(e['color'], 0), 5)
            : 0,
        ...(tree !== undefined ? { tree } : {}),
        ...(typeof e['revision'] === 'string' ? { revision: (e['revision'] as string).slice(0, 64) } : {}),
      };
    });
}
