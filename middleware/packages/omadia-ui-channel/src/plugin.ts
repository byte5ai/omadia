import type { PluginContext } from '@omadia/plugin-api';
import type { ChannelHandle, CoreApi } from '@omadia/channel-sdk';

/**
 * @omadia/ui-channel — Omadia UI Tier-1 server-side channel, skeleton (PR-10a).
 *
 * `kind: channel`. The manifest declares the canvas surface — `capabilities:
 * [text, canvas]` and `dispatch_service: canvasChatAgent` — so a turn routes to
 * the omadia-ui-orchestrator (#168 dispatch + #171 canvasChatAgent).
 *
 * v0 registers a DISCOVERY endpoint that advertises the omadia-canvas-protocol
 * + ops-catalog versions and the channel's capabilities (what a client reads
 * before connecting). The bidirectional WebSocket transport — handshake
 * (offer→select→ack), turn intake (`IncomingTurn` forming), and `surface_*`
 * event fan-out — is DEFERRED: the {@link CoreApi} exposes only Express
 * route/router registration, not a WebSocket upgrade, so hosting the canvas
 * WebSocket needs a CoreApi SDK extension that the concept's SDK-changes list
 * omitted (documented as plan feed-back). The dispatch wiring
 * (`dispatch_service` → `canvasChatAgent`) is already validated by #168.
 */

export const CANVAS_PROTOCOL_VERSION = '1.0';
export const OPS_CATALOG_VERSION = '1.0';

/** Pre-connect discovery route — transport-agnostic capability advertisement. */
export const INFO_PATH = '/omadia-ui/info';

export async function activate(
  ctx: PluginContext,
  core: CoreApi,
): Promise<ChannelHandle> {
  ctx.log('activating omadia-ui-channel (skeleton)');

  core.registerRoute(ctx.agentId, 'GET', INFO_PATH, (_req, res) => {
    res.json({
      channel: ctx.agentId,
      protocolVersions: [CANVAS_PROTOCOL_VERSION],
      opsCatalogVersions: [OPS_CATALOG_VERSION],
      capabilities: ['text', 'canvas'],
      dispatchService: 'canvasChatAgent',
      transport: 'websocket',
      websocket: 'not-yet-implemented',
    });
  });

  ctx.log(`[omadia-ui-channel] discovery endpoint at GET ${INFO_PATH}`);

  return {
    async close(): Promise<void> {
      ctx.log('deactivating omadia-ui-channel');
      // Channel-scoped routes are torn down by the kernel per channelId on
      // deactivate (CoreApi.registerRoute contract) — nothing else to release.
    },
  };
}
