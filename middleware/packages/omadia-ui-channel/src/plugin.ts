import { randomUUID } from 'node:crypto';

import type { PluginContext } from '@omadia/plugin-api';
import type { ChannelHandle, CoreApi } from '@omadia/channel-sdk';

import { handleCanvasSocket } from './canvasConnection.js';
import {
  sanitizeCanvasList,
  sanitizeDesktopList,
  type CanvasListEntry,
  type DesktopListEntry,
  type NotificationMsg,
} from './protocol.js';

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

/** Derive an absolute `ws(s)://host/omadia-ui/canvas` from the discovery
 *  request, honouring the reverse-proxy `x-forwarded-*` headers the Fly edge
 *  (and any proxy) sets. Mirrors the kernel's `resolveScheme` (#293) but stays
 *  inline so the channel plugin keeps zero runtime deps on the kernel. */
function absoluteCanvasWsUrl(req: {
  headers: Record<string, string | string[] | undefined>;
  /** `req.socket.encrypted` (tls.TLSSocket) — true on a direct TLS connection. */
  encrypted?: boolean;
}): string {
  const first = (name: string): string | undefined => {
    const v = req.headers[name];
    const raw = Array.isArray(v) ? v[0] : v;
    return raw?.split(',')[0]?.trim() || undefined;
  };
  const xfProto = first('x-forwarded-proto');
  const secure = xfProto ? xfProto === 'https' : Boolean(req.encrypted);
  const host = first('x-forwarded-host') ?? first('host') ?? 'localhost';
  return `${secure ? 'wss' : 'ws'}://${host}${CANVAS_PATH}`;
}

export async function activate(
  ctx: PluginContext,
  core: CoreApi,
): Promise<ChannelHandle> {
  ctx.log('activating omadia-ui-channel');

  const wsAvailable = typeof core.registerWebSocket === 'function';

  core.registerRoute(ctx.agentId, 'GET', INFO_PATH, (req, res) => {
    // Back-compat discovery alias. Returns the same legacy fields plus an
    // ABSOLUTE canvas `wsUrl` (#293) so a client that only knows this endpoint
    // still gets a connect-ready URL without hand-assembling scheme + host +
    // path. The canonical, auth-aware descriptor lives at
    // `/.well-known/omadia-ui` (served by the kernel).
    const wsUrl = wsAvailable
      ? absoluteCanvasWsUrl({
          headers: req.headers,
          encrypted: Boolean(
            (req.socket as { encrypted?: boolean } | undefined)?.encrypted,
          ),
        })
      : undefined;
    res.json({
      channel: ctx.agentId,
      protocolVersions: [CANVAS_PROTOCOL_VERSION],
      opsCatalogVersions: [OPS_CATALOG_VERSION],
      capabilities: ['text', 'canvas'],
      dispatchService: 'canvasChatAgent',
      transport: 'websocket',
      // Legacy relative path kept for older clients; `wsUrl` is the absolute
      // form new clients should prefer.
      websocket: wsAvailable ? CANVAS_PATH : 'unavailable',
      ...(wsUrl ? { wsUrl } : {}),
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

  // Per-USER desktop registry (multi-desktop workspaces): same persistence
  // pattern as the canvas registry — desktops travel across installs.
  const volatileDesktops = new Map<string, DesktopListEntry[]>();
  const desktopPath = (subject: string): string =>
    `desktops/${encodeURIComponent(subject)}.json`;
  const desktopRegistry = {
    async load(subject: string): Promise<DesktopListEntry[]> {
      if (!memory) return volatileDesktops.get(subject) ?? [];
      const rel = desktopPath(subject);
      if (!(await memory.exists(rel))) return [];
      return sanitizeDesktopList(JSON.parse(await memory.readFile(rel)));
    },
    async save(subject: string, desktops: DesktopListEntry[]): Promise<void> {
      if (!memory) {
        volatileDesktops.set(subject, desktops);
        return;
      }
      await memory.writeFile(desktopPath(subject), JSON.stringify(desktops));
    },
  };

  // Notifications (omadia-ui#15): live sinks per authenticated subject. The
  // NotificationRouter handler below maps a middleware payload onto the wire
  // `notification` message and fans it out to the target user's sockets —
  // out-of-band from the canvas surface stream.
  const notificationSinks = new Map<string, Set<(msg: unknown) => void>>();
  const registerNotificationSink = (
    subject: string,
    sink: (msg: unknown) => void,
  ): (() => void) => {
    const set = notificationSinks.get(subject) ?? new Set();
    set.add(sink);
    notificationSinks.set(subject, set);
    return () => {
      set.delete(sink);
      if (set.size === 0) notificationSinks.delete(subject);
    };
  };
  const disposeNotificationChannel = ctx.notifications.registerChannel(
    'omadia-ui',
    async (payload) => {
      const msg: NotificationMsg = {
        type: 'notification',
        id: randomUUID(),
        // producer payloads carry no severity yet — default to info; the
        // wire shape is ready for it (severity → UI element is fixed
        // client-side: info/success toast, warning/error banner).
        severity: 'info',
        title: payload.title.slice(0, 120),
        ...(payload.body ? { body: payload.body.slice(0, 1000) } : {}),
        source: payload.pluginId,
        dedupeKey: `${payload.pluginId}:${payload.title.slice(0, 120)}`,
        ttlMs: 6000,
      };
      const targets =
        payload.recipients === 'broadcast'
          ? [...notificationSinks.values()]
          : [...notificationSinks.entries()]
              .filter(([subject]) => (payload.recipients as readonly string[]).includes(subject))
              .map(([, sinks]) => sinks);
      let delivered = 0;
      for (const sinks of targets) {
        for (const sink of sinks) {
          sink(msg);
          delivered += 1;
        }
      }
      ctx.log(
        `[omadia-ui-channel] notification from ${payload.pluginId} delivered to ${delivered} socket(s)`,
      );
    },
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
        desktopRegistry,
        registerNotificationSink,
        onNotificationAck: (subject, id) => {
          // v1: dismissal is client-persisted; server-side history sync is a
          // later slice (issue #15 open question).
          ctx.log(`[omadia-ui-channel] notification_ack ${id} from ${subject}`);
        },
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
      // closes this channel's live canvas sockets. The NotificationRouter
      // registration must be disposed explicitly (hot-swap contract).
      disposeNotificationChannel();
      notificationSinks.clear();
    },
  };
}
