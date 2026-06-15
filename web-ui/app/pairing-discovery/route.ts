import { NextResponse } from 'next/server';

/**
 * Friction-free pairing discovery on the OPERATOR origin (#293).
 *
 * Public path: `/.well-known/omadia-ui` (rewritten to this handler in
 * `next.config.ts`). A desktop client GETs the one URL the user already
 * knows — the operator/browser URL — and gets back a connect-ready descriptor.
 * This closes the split-deployment gap: the Next operator front gates the
 * browser UI and does NOT route the canvas WebSocket (that lives on the
 * separate middleware service), so without this endpoint the desktop app has
 * no in-product way to discover the transport URL.
 *
 * The server owns the mapping "human URL → transport URL":
 *   - `wsUrl`        absolute canvas WS URL. Set `OMADIA_UI_PUBLIC_WS_URL` to
 *                    the publicly reachable transport (operator-proxied path or
 *                    the middleware's public host). Falls back to deriving the
 *                    same operator origin when unset.
 *   - `auth`         providers fetched server-side from the middleware, with an
 *                    absolute `loginStartUrl` on the operator's already-working
 *                    `/bot-api/v1/auth` proxy — so the desktop app authenticates
 *                    without the middleware needing a public edge.
 *
 * Runs in the Node runtime so it can reach the flycast-internal middleware.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROTOCOL_VERSION = '1.0';
const CANVAS_WS_PATH = '/omadia-ui/canvas';

const middlewareUrl = process.env.MIDDLEWARE_URL ?? 'http://localhost:3979';

interface ProviderSummary {
  id: string;
  displayName: string;
  kind: 'password' | 'oidc';
}

function operatorOrigin(req: Request): { httpProto: string; host: string } {
  const headers = req.headers;
  const xfProto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  // `req.url` carries the proxied internal scheme; trust the forwarded header
  // (set by the Fly edge / any reverse proxy) and default to https in prod.
  const httpProto = xfProto ?? new URL(req.url).protocol.replace(':', '');
  const host =
    headers.get('x-forwarded-host')?.split(',')[0]?.trim() ??
    headers.get('host') ??
    new URL(req.url).host;
  return { httpProto, host };
}

async function fetchProviders(): Promise<ProviderSummary[] | undefined> {
  try {
    const res = await fetch(`${middlewareUrl}/api/v1/auth/providers`, {
      // Server-to-server on the private network; never cache auth state.
      cache: 'no-store',
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { providers?: ProviderSummary[] };
    return Array.isArray(body.providers) ? body.providers : undefined;
  } catch {
    // Middleware unreachable at discovery time — degrade to "auth unknown"
    // rather than failing the whole pairing handshake.
    return undefined;
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  const { httpProto, host } = operatorOrigin(req);
  const origin = `${httpProto}://${host}`;

  const override = process.env.OMADIA_UI_PUBLIC_WS_URL?.trim();
  const wsUrl =
    override ||
    `${httpProto === 'https' ? 'wss' : 'ws'}://${host}${CANVAS_WS_PATH}`;

  const providers = await fetchProviders();
  const mode = providers?.length
    ? providers.some((p) => p.kind === 'oidc')
      ? 'oidc'
      : 'password'
    : 'none';

  return NextResponse.json({
    name: process.env.OMADIA_UI_INSTANCE_NAME?.trim() || host,
    protocolVersion: PROTOCOL_VERSION,
    protocolVersions: [PROTOCOL_VERSION],
    wsUrl,
    auth:
      mode === 'none'
        ? { mode }
        : {
            mode,
            providers,
            // The operator proxies `/bot-api/*` → middleware `/api/*`; the
            // desktop app uses this absolute base directly, so the middleware
            // never needs a public edge.
            loginStartUrl: `${origin}/bot-api/v1/auth`,
          },
  });
}
