import type { HandshakeSelect, ServerMessage } from './protocol.js';

export interface HandshakeConfig {
  /** preference-ordered versions this client implements */
  protocolVersions: string[];
  opsCatalogVersions: string[];
  /** the ops-catalog subset this build actually implements (Class-B routing truth) */
  localOperations: string[];
  /** persisted across reconnects to resume a canvas */
  canvasSessionId?: string;
}

export type HandshakeAction =
  | { kind: 'send'; message: HandshakeSelect }
  | { kind: 'ready'; canvasSessionId: string }
  | { kind: 'fail'; reason: string };

/**
 * Pure client half of the omadia-canvas-protocol/1.0 boot handshake
 * (offer → select → ack, one downgrade retry on handshake_error).
 * Transport-agnostic: feed it parsed server messages, act on the returned action.
 */
export function createHandshake(config: HandshakeConfig): {
  onMessage(msg: ServerMessage): HandshakeAction | null;
} {
  let handshakeId: string | null = null;
  let selectsSent = 0;
  let settled = false;

  const pick = (offeredProto: string[], offeredOps: string[]): HandshakeSelect | null => {
    const protocolVersion = config.protocolVersions.find((v) => offeredProto.includes(v));
    const opsCatalogVersion = config.opsCatalogVersions.find((v) => offeredOps.includes(v));
    if (!protocolVersion || !opsCatalogVersion || handshakeId === null) return null;
    return {
      type: 'handshake_select',
      handshakeId,
      protocolVersion,
      opsCatalogVersion,
      localOperations: config.localOperations,
      ...(config.canvasSessionId ? { canvasSessionId: config.canvasSessionId } : {}),
    };
  };

  return {
    onMessage(msg: ServerMessage): HandshakeAction | null {
      if (settled) return null;

      if (msg.type === 'handshake_offer') {
        handshakeId = msg.handshakeId;
        const select = pick(msg.protocolVersions, msg.opsCatalogVersions);
        if (!select) {
          settled = true;
          return { kind: 'fail', reason: 'no mutual protocol/ops-catalog version' };
        }
        selectsSent += 1;
        return { kind: 'send', message: select };
      }

      if (msg.type === 'handshake_error') {
        if (selectsSent >= 2) {
          settled = true;
          return { kind: 'fail', reason: `handshake rejected twice (${msg.reason})` };
        }
        const select = pick(msg.supported.protocolVersions, msg.supported.opsCatalogVersions);
        if (!select) {
          settled = true;
          return { kind: 'fail', reason: `no downgrade path (${msg.reason})` };
        }
        selectsSent += 1;
        return { kind: 'send', message: select };
      }

      if (msg.type === 'handshake_ack') {
        settled = true;
        return { kind: 'ready', canvasSessionId: msg.canvasSessionId };
      }

      return null; // pre-handshake surface/turn frames: ignore
    },
  };
}
