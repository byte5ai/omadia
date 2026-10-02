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
 * Anyone can call this: `proxy.ts` exempts it from the login gate, because
 * the client has no session yet. So the handler neither waits long on the
 * middleware nor guesses. When it cannot read the provider list, it answers
 * `503` with `Retry-After` instead of a descriptor. It never falls back to
 * `auth.mode: 'none'`, which tells a client that no sign-in is needed.
 *
 * Runs in the Node runtime so it can reach the flycast-internal middleware.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROTOCOL_VERSION = '1.0';
const CANVAS_WS_PATH = '/omadia-ui/canvas';

/**
 * Deadline for the provider read, body included. A healthy middleware answers
 * in milliseconds on the private network. Without a deadline, one that
 * accepts the connection and never replies would hold every discovery request
 * open for as long as undici's own timeouts allow, which is minutes.
 */
const PROVIDERS_FETCH_TIMEOUT_MS = 5_000;

/** How long a client should wait before it asks again after a `503`. */
const RETRY_AFTER_SECONDS = 5;

/**
 * Sent with every answer. The descriptor echoes the caller's host into
 * `wsUrl` and `loginStartUrl`, so no shared cache may replay one caller's copy
 * to another, and a `503` is only true for the moment. `force-dynamic` turns
 * off Next's own caching, not a cache in front of it.
 */
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

const middlewareUrl = process.env.MIDDLEWARE_URL ?? 'http://localhost:3979';

interface ProviderSummary {
  id: string;
  displayName: string;
  kind: 'password' | 'oidc';
}

/** The provider read yields either the list or the reason it could not. */
type ProvidersRead =
  | { readonly ok: true; readonly providers: ProviderSummary[] }
  | { readonly ok: false; readonly reason: string };

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

/** `fetch failed` alone tells an operator nothing; the cause code does. */
function describeFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { cause?: { code?: unknown } }).cause?.code;
  return `${err.name}: ${err.message}${typeof code === 'string' ? ` (${code})` : ''}`;
}

async function readProviders(): Promise<ProvidersRead> {
  try {
    const res = await fetch(`${middlewareUrl}/api/v1/auth/providers`, {
      // Server-to-server on the private network; never cache auth state.
      cache: 'no-store',
      signal: AbortSignal.timeout(PROVIDERS_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = (await res.json()) as { providers?: unknown };
    if (!Array.isArray(body.providers)) {
      return { ok: false, reason: 'the response carries no provider list' };
    }
    return { ok: true, providers: body.providers as ProviderSummary[] };
  } catch (err) {
    // Unreachable, past the deadline, or a body that is not JSON.
    return { ok: false, reason: describeFailure(err) };
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  const read = await readProviders();
  if (!read.ok) {
    console.warn(
      `[pairing-discovery] provider list unavailable (${read.reason}); answering 503`,
    );
    return NextResponse.json(
      {
        code: 'pairing.auth_unavailable',
        message: 'The sign-in providers could not be determined. Try again shortly.',
      },
      {
        status: 503,
        headers: { ...NO_STORE, 'Retry-After': String(RETRY_AFTER_SECONDS) },
      },
    );
  }

  const { httpProto, host } = operatorOrigin(req);
  const origin = `${httpProto}://${host}`;

  const override = process.env.OMADIA_UI_PUBLIC_WS_URL?.trim();
  const wsUrl =
    override ||
    `${httpProto === 'https' ? 'wss' : 'ws'}://${host}${CANVAS_WS_PATH}`;

  // `none` only for a list the middleware returned empty, which is how its own
  // `buildPairingDescriptor` reads that state. A list that could not be read
  // never gets this far.
  const { providers } = read;
  const mode =
    providers.length === 0
      ? 'none'
      : providers.some((p) => p.kind === 'oidc')
        ? 'oidc'
        : 'password';

  return NextResponse.json(
    {
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
    },
    { headers: NO_STORE },
  );
}
