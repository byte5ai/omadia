import type {
  CanvasViewState,
  ChannelSessionClaims,
  ChannelSocket,
  ChatStreamEvent,
  IncomingTurn,
} from '@omadia/channel-sdk';
import type { TargetRef } from '@omadia/plugin-api';

import {
  parseClientMessage,
  SURFACE_EVENT_TYPES,
  type ClientTurn,
  type HandshakeAck,
  type HandshakeError,
  type HandshakeOffer,
} from './protocol.js';

/**
 * Everything one canvas connection needs from the host, injected so the state
 * machine is testable without a live WebSocket or kernel.
 */
export interface CanvasConnectionDeps {
  /** the channel plugin's catalog id — becomes `IncomingTurn.channelId`. */
  channelId: string;
  /** protocol versions this server offers (e.g. `['1.0']`). */
  protocolVersions: string[];
  /** ops-catalog versions this server offers (e.g. `['1.0']`). */
  opsCatalogVersions: string[];
  /** drive an orchestrator turn — `core.handleTurnStream`. */
  handleTurnStream: (turn: IncomingTurn) => AsyncIterable<ChatStreamEvent>;
  /** per-deployment tenant id (from `graphTenantId`); omit → core defaults it. */
  tenantId?: string;
  /** mint a handshakeId / canvasSessionId / turnId. Injected for deterministic tests. */
  mintId: () => string;
  log?: (msg: string) => void;
}

type Phase = 'awaiting_select' | 'ready' | 'closed';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Drive one authenticated canvas WebSocket: server-initiated handshake
 * (`offer` → `select` → `ack`, with a single version-mismatch downgrade chance
 * before close), then a turn loop that forms an {@link IncomingTurn} per client
 * `turn` message and fans the orchestrator stream back out — `surface_*` events
 * 1:1, agent prose as `agent_text_delta`, terminated by `turn_complete` /
 * `turn_error`.
 *
 * The socket is already authenticated by the kernel WebSocketRegistry (PR-11);
 * `session` is the verified identity. Turns are serialised per connection so
 * their surface frames never interleave.
 */
export function handleCanvasSocket(
  socket: ChannelSocket,
  session: ChannelSessionClaims,
  deps: CanvasConnectionDeps,
): void {
  let phase: Phase = 'awaiting_select';
  let downgradeAttempts = 0;
  /** the client-facing canvas id (client-supplied or server-minted). */
  let canvasSessionId = '';
  const handshakeId = deps.mintId();
  // Per-connection turn queue — serialises turns so two in-flight turns can't
  // interleave surface frames on the same socket.
  let turnChain: Promise<void> = Promise.resolve();

  const send = (msg: unknown): void => {
    if (phase === 'closed') return;
    socket.send(JSON.stringify(msg));
  };

  socket.onClose(() => {
    phase = 'closed';
  });

  // 1. Server-initiated offer.
  const offer: HandshakeOffer = {
    type: 'handshake_offer',
    handshakeId,
    protocolVersions: deps.protocolVersions,
    opsCatalogVersions: deps.opsCatalogVersions,
  };
  send(offer);

  socket.onMessage((raw) => {
    if (phase === 'closed') return;
    const msg = parseClientMessage(raw);
    if (!msg) {
      deps.log?.('[ui-channel] dropped unparseable client frame');
      return;
    }

    if (phase === 'awaiting_select') {
      if (msg.type !== 'handshake_select') return; // ignore traffic pre-handshake
      // Correlate to the offer we minted — a select for a different handshake is
      // a confused/replayed client; ignore it.
      if (msg.handshakeId !== handshakeId) {
        deps.log?.('[ui-channel] handshake_select with mismatched handshakeId');
        return;
      }
      const protoOk = deps.protocolVersions.includes(msg.protocolVersion);
      const opsOk = deps.opsCatalogVersions.includes(msg.opsCatalogVersion);
      if (!protoOk || !opsOk) {
        const err: HandshakeError = {
          type: 'handshake_error',
          handshakeId,
          reason: !protoOk
            ? 'protocol-version-unsupported'
            : 'ops-catalog-version-unsupported',
          supported: {
            protocolVersions: deps.protocolVersions,
            opsCatalogVersions: deps.opsCatalogVersions,
          },
        };
        send(err);
        downgradeAttempts += 1;
        // One downgrade chance; a second mismatch closes the connection.
        if (downgradeAttempts >= 2) {
          phase = 'closed';
          socket.close(1002, 'handshake version mismatch');
        }
        return;
      }
      canvasSessionId =
        msg.canvasSessionId && msg.canvasSessionId.length > 0
          ? msg.canvasSessionId
          : deps.mintId();
      const ack: HandshakeAck = {
        type: 'handshake_ack',
        handshakeId,
        canvasSessionId,
      };
      send(ack);
      phase = 'ready';
      return;
    }

    // phase === 'ready'
    if (msg.type !== 'turn') return;
    const turnId =
      msg.turnId && msg.turnId.length > 0 ? msg.turnId : deps.mintId();
    // Validate client-controlled shapes before dispatch — the channel is a
    // transport, but it must not push obviously-malformed target/viewState into
    // the orchestrator. Full structural validation (the 10 TargetRef variants,
    // the viewState budget) is the Tier-2 protocol whitelist's job.
    const invalid = validateTurnInput(msg);
    if (invalid) {
      send({ type: 'turn_error', forTurn: turnId, message: invalid });
      return;
    }
    // Serialise: each turn runs to completion before the next starts.
    turnChain = turnChain.then(() => runTurn(msg, turnId)).catch(() => {
      /* runTurn never rejects (it sends turn_error); guard the chain anyway. */
    });
  });

  function validateTurnInput(msg: ClientTurn): string | null {
    if (
      msg.target !== undefined &&
      !(isPlainObject(msg.target) && typeof msg.target['kind'] === 'string')
    ) {
      return 'invalid target: expected an object with a string `kind`';
    }
    if (msg.viewState !== undefined && !isPlainObject(msg.viewState)) {
      return 'invalid viewState: expected an object keyed by containerId';
    }
    return null;
  }

  async function runTurn(msg: ClientTurn, turnId: string): Promise<void> {
    const turn = formIncomingTurn(msg, turnId);
    let terminated = false;
    try {
      for await (const ev of deps.handleTurnStream(turn)) {
        if (phase === 'closed') return;
        if (SURFACE_EVENT_TYPES.has(ev.type)) {
          send(ev); // forward the surface_* event 1:1
        } else if (ev.type === 'text_delta') {
          send({ type: 'agent_text_delta', forTurn: turnId, text: ev.text });
        } else if (ev.type === 'error') {
          // A mid-stream error terminates the turn — `turn_error` instead of,
          // not in addition to, `turn_complete`.
          send({ type: 'turn_error', forTurn: turnId, message: ev.message });
          terminated = true;
          break;
        }
        // iteration_start / tool_* / sub_* / verifier / turn_annotation are
        // internal orchestrator telemetry — not part of the canvas wire.
      }
      if (!terminated && phase !== 'closed') {
        send({ type: 'turn_complete', forTurn: turnId });
      }
    } catch (err) {
      send({
        type: 'turn_error',
        forTurn: turnId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function formIncomingTurn(msg: ClientTurn, turnId: string): IncomingTurn {
    const turn: IncomingTurn = {
      channelId: deps.channelId,
      // SECURITY: the orchestrator scope is `${channelId}::${conversationId}`
      // and is NOT user-scoped by the core, so the client-supplied
      // canvasSessionId is namespaced under the authenticated subject. Without
      // this, user A supplying user B's canvasSessionId would join B's canvas
      // memory scope. The raw client id stays in metadata + the handshake ack.
      conversationId: `${session.subject}::${canvasSessionId}`,
      userRef: {
        kind: 'custom',
        id: session.subject,
        ...(session.displayName ? { displayName: session.displayName } : {}),
        ...(session.email ? { email: session.email } : {}),
      },
      text: typeof msg.text === 'string' ? msg.text : '',
      metadata: {
        canvasSessionId,
        turnId,
        provider: session.provider,
        ...(session.omadiaUserId ? { omadiaUserId: session.omadiaUserId } : {}),
      },
    };
    // tenantId: populate when the host published one; otherwise leave unset so
    // the core call-site defaults it to 'default' (single-tenant v1). Real
    // multi-tenant derivation (per host / per session) is a later slice.
    if (deps.tenantId) turn.tenantId = deps.tenantId;
    // Shape already guarded by validateTurnInput; full whitelist is Tier 2's.
    if (msg.target !== undefined) turn.target = msg.target as TargetRef;
    if (msg.viewState !== undefined) {
      turn.viewState = msg.viewState as CanvasViewState;
    }
    if (msg.viewStateTruncated === true) turn.viewStateTruncated = true;
    return turn;
  }
}
