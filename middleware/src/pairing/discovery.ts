/**
 * Friction-free pairing discovery (#293).
 *
 * The server owns the mapping "human-facing URL → transport URL", not the
 * user. A client that hits any Omadia origin with a discovery GET gets back a
 * single source-agnostic descriptor it can connect with — no scheme juggling,
 * no `/omadia-ui/canvas` suffix to remember. The same descriptor shape is
 * produced by the LAN mDNS path, the public HTTP path, and manual entry on the
 * client; here we build the HTTP half.
 *
 * `wsUrl` is always ABSOLUTE (host included) so it survives split deployments
 * where the operator front and the canvas transport live on different hosts.
 * Resolution order:
 *   1. an explicit override (`OMADIA_UI_PUBLIC_WS_URL`) — for proxied / split
 *      topologies where the transport host is not the request host;
 *   2. otherwise derived from the request origin (honouring `x-forwarded-*`
 *      so it is correct behind the Fly edge / any reverse proxy).
 */

/** Canvas WebSocket path — kept in sync with `@omadia/omadia-ui-channel`'s
 *  `CANVAS_PATH`. A stable wire constant; duplicated here to avoid a runtime
 *  dependency from the kernel onto a channel plugin package. */
export const CANVAS_WS_PATH = '/omadia-ui/canvas';

/** Discovery endpoints. `/.well-known/omadia-ui` is the canonical one; the
 *  channel's `/omadia-ui/info` is the legacy/back-compat alias. */
export const WELL_KNOWN_PATH = '/.well-known/omadia-ui';

export const PAIRING_PROTOCOL_VERSION = '1.0';

export interface ProviderSummaryLike {
  readonly id: string;
  readonly displayName: string;
  readonly kind: 'password' | 'oidc';
}

export interface PairingAuth {
  /** Coarse hint for the client's first-render; the authoritative list is
   *  `providers`. `none` means the host accepts unauthenticated connects. */
  readonly mode: 'none' | 'password' | 'oidc';
  readonly providers?: ProviderSummaryLike[];
  /** Absolute base the client POSTs/redirects to for auth (`…/api/v1/auth`). */
  readonly loginStartUrl?: string;
}

export interface PairingDescriptor {
  readonly name: string;
  readonly protocolVersion: string;
  /** Kept for forward-compat with multi-version hosts; mirrors the channel. */
  readonly protocolVersions: string[];
  /** Absolute `ws(s)://host/omadia-ui/canvas`. */
  readonly wsUrl: string;
  readonly auth: PairingAuth;
}

/** The minimal request shape the resolver needs — kept express-free so the
 *  helper is trivially unit-testable. An express `Request` satisfies it. */
export interface PairingRequestInfo {
  readonly headers: Record<string, string | string[] | undefined>;
  /** `req.socket.encrypted` — true on a direct TLS connection. */
  readonly encrypted?: boolean;
}

export interface PairingDescriptorOptions {
  /** `OMADIA_UI_INSTANCE_NAME` — human label for the host. */
  readonly instanceName?: string;
  /** `OMADIA_UI_PUBLIC_WS_URL` — absolute override for the canvas transport. */
  readonly publicWsUrl?: string;
  /** Active auth providers, or undefined/empty when auth is disabled. */
  readonly providers?: ProviderSummaryLike[];
}

function firstHeader(
  req: PairingRequestInfo,
  name: string,
): string | undefined {
  const v = req.headers[name];
  const raw = Array.isArray(v) ? v[0] : v;
  return raw?.split(',')[0]?.trim() || undefined;
}

export interface ResolvedScheme {
  readonly secure: boolean;
  readonly httpProto: 'http' | 'https';
  readonly wsProto: 'ws' | 'wss';
  readonly host: string;
}

/** Derive the public scheme + host the client actually reached, honouring the
 *  reverse-proxy `x-forwarded-*` headers the Fly edge sets. */
export function resolveScheme(req: PairingRequestInfo): ResolvedScheme {
  const xfProto = firstHeader(req, 'x-forwarded-proto');
  const secure = xfProto ? xfProto === 'https' : Boolean(req.encrypted);
  const host =
    firstHeader(req, 'x-forwarded-host') ??
    firstHeader(req, 'host') ??
    'localhost';
  return {
    secure,
    httpProto: secure ? 'https' : 'http',
    wsProto: secure ? 'wss' : 'ws',
    host,
  };
}

/** Absolute canvas WS URL — the override if configured, else request-derived. */
export function resolveCanvasWsUrl(
  req: PairingRequestInfo,
  opts: { publicWsUrl?: string } = {},
): string {
  const override = opts.publicWsUrl?.trim();
  if (override) return override;
  const { wsProto, host } = resolveScheme(req);
  return `${wsProto}://${host}${CANVAS_WS_PATH}`;
}

function deriveAuth(
  req: PairingRequestInfo,
  providers: ProviderSummaryLike[] | undefined,
): PairingAuth {
  if (!providers || providers.length === 0) return { mode: 'none' };
  const { httpProto, host } = resolveScheme(req);
  const mode: PairingAuth['mode'] = providers.some((p) => p.kind === 'oidc')
    ? 'oidc'
    : 'password';
  return {
    mode,
    providers,
    loginStartUrl: `${httpProto}://${host}/api/v1/auth`,
  };
}

/** Build the unified pairing descriptor for an incoming discovery request. */
export function buildPairingDescriptor(
  req: PairingRequestInfo,
  opts: PairingDescriptorOptions = {},
): PairingDescriptor {
  const { host } = resolveScheme(req);
  return {
    name: opts.instanceName?.trim() || host,
    protocolVersion: PAIRING_PROTOCOL_VERSION,
    protocolVersions: [PAIRING_PROTOCOL_VERSION],
    wsUrl: resolveCanvasWsUrl(req, { publicWsUrl: opts.publicWsUrl }),
    auth: deriveAuth(req, opts.providers),
  };
}
