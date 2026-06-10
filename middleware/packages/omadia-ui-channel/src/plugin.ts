import { randomUUID } from 'node:crypto';

import type { PluginContext } from '@omadia/plugin-api';
import type { ChannelHandle, CoreApi } from '@omadia/channel-sdk';

import { handleCanvasSocket } from './canvasConnection.js';
import { sanitizeCanvasList, type CanvasListEntry } from './protocol.js';

/**
 * @omadia/ui-channel — Omadia UI Tier-1 server-side channel (PR-10b).
 *
 * `kind: channel`. The manifest declares the canvas surface — `capabilities:
 * [text, canvas]` and `dispatch_service: canvasChatAgent` — so a turn routes to
 * the omadia-ui-orchestrator (#168 dispatch + #171 canvasChatAgent).
 *
 * Two surfaces:
 *   - a pre-connect DISCOVERY route (`GET /omadia-ui/info`) advertising the
 *     omadia-canvas-protocol + ops-catalog versions and capabilities (what a
 *     client reads before connecting); and
 *   - the bidirectional canvas WebSocket (`/omadia-ui/canvas`) over PR-11's
 *     `CoreApi.registerWebSocket`: a server-initiated handshake
 *     (`offer→select→ack`), `IncomingTurn` forming per client `turn`, and a 1:1
 *     `surface_*` fan-out of the orchestrator stream. The connection logic lives
 *     in {@link handleCanvasSocket}; the kernel authenticates each upgrade
 *     before the handler runs.
 *
 * The WebSocket is feature-detected: if the kernel CoreApi has no
 * `registerWebSocket` (no WS registry wired), the channel degrades to the
 * discovery route only, inert and non-failing.
 */

export const CANVAS_PROTOCOL_VERSION = '1.0';
export const OPS_CATALOG_VERSION = '1.0';

/** Pre-connect discovery route — transport-agnostic capability advertisement. */
export const INFO_PATH = '/omadia-ui/info';

/** Bidirectional canvas WebSocket path (registered via CoreApi.registerWebSocket). */
export const CANVAS_PATH = '/omadia-ui/canvas';

export async function activate(
  ctx: PluginContext,
  core: CoreApi,
): Promise<ChannelHandle> {
  ctx.log('activating omadia-ui-channel');

  const wsAvailable = typeof core.registerWebSocket === 'function';

  core.registerRoute(ctx.agentId, 'GET', INFO_PATH, (_req, res) => {
    res.json({
      channel: ctx.agentId,
      protocolVersions: [CANVAS_PROTOCOL_VERSION],
      opsCatalogVersions: [OPS_CATALOG_VERSION],
      capabilities: ['text', 'canvas'],
      dispatchService: 'canvasChatAgent',
      transport: 'websocket',
      websocket: wsAvailable ? CANVAS_PATH : 'unavailable',
    });
  });
  ctx.log(`[omadia-ui-channel] discovery endpoint at GET ${INFO_PATH}`);

  // Bidirectional canvas transport. Feature-detected: present only when the
  // kernel wired a WebSocket registry into the CoreApi (PR-11). The kernel
  // authenticates each upgrade before this handler runs — `session` is the
  // verified identity; each connection is one canvas.
  // Per-USER canvas registry (multi-canvas sidebar sync): persisted in the
  // plugin memory store when the manifest grants it (survives restarts and is
  // shared across server instances on a DB-backed memory); in-memory fallback
  // otherwise so the wire contract still holds.
  const memory = ctx.memory;
  const volatileRegistry = new Map<string, CanvasListEntry[]>();
  const registryPath = (subject: string): string =>
    `canvases/${encodeURIComponent(subject)}.json`;
  const canvasRegistry = {
    async load(subject: string): Promise<CanvasListEntry[]> {
      if (!memory) return volatileRegistry.get(subject) ?? [];
      const rel = registryPath(subject);
      if (!(await memory.exists(rel))) return [];
      return sanitizeCanvasList(JSON.parse(await memory.readFile(rel)));
    },
    async save(subject: string, canvases: CanvasListEntry[]): Promise<void> {
      if (!memory) {
        volatileRegistry.set(subject, canvases);
        return;
      }
      await memory.writeFile(registryPath(subject), JSON.stringify(canvases));
    },
  };
  ctx.log(
    `[omadia-ui-channel] canvas registry ${memory ? 'memory-backed' : 'VOLATILE (no memory permission)'}`,
  );

  if (wsAvailable) {
    const tenantId = ctx.services.get<string>('graphTenantId');
    core.registerWebSocket?.(ctx.agentId, CANVAS_PATH, (socket, session) => {
      handleCanvasSocket(socket, session, {
        channelId: ctx.agentId,
        protocolVersions: [CANVAS_PROTOCOL_VERSION],
        opsCatalogVersions: [OPS_CATALOG_VERSION],
        handleTurnStream: (turn) => core.handleTurnStream(turn),
        ...(tenantId ? { tenantId } : {}),
        mintId: () => randomUUID(),
        canvasRegistry,
        log: (msg) => {
          ctx.log(msg);
        },
      });
    });
    ctx.log(`[omadia-ui-channel] canvas WebSocket at ${CANVAS_PATH}`);
  } else {
    ctx.log(
      '[omadia-ui-channel] core has no registerWebSocket — canvas WS inactive (discovery route only)',
    );
  }

  return {
    async close(): Promise<void> {
      ctx.log('deactivating omadia-ui-channel');
      // Channel-scoped routes AND WebSocket registrations are torn down by the
      // kernel per channelId on deactivate (CoreApi contract) — the kernel also
      // closes this channel's live canvas sockets. Nothing else to release.
    },
  };
}
