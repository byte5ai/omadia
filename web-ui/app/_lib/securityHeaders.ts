/**
 * Response security headers for the operator UI, applied per request by
 * `proxy.ts`.
 *
 * WHY THE PROXY AND NOT next.config.ts `headers()`. Next evaluates
 * `headers()` at build time and freezes the result into the routes manifest,
 * the same trap that once baked the compose hostname into `rewrites()` (see
 * `middlewareProxy.ts`). An operator who has to allow framing sets
 * `UI_FRAME_ANCESTORS` on a published image, so the value must be read at
 * request time.
 *
 * WHY `/p/*` AND `/bot-api/*` ARE LEFT ALONE. Both prefixes are route handlers
 * that stream middleware responses, and several of those responses are
 * documents that ARE framed: plugin UIs (`PluginUiFrame` loads
 * `/p/<id>/ui/index.html`, Teams tabs load `/p/*` cross-origin), the store's
 * admin panel (`/bot-api<admin_ui_path>`) and the builder preview
 * (`/bot-api/v1/builder/.../preview/ui-route/...`). The middleware sets their
 * CSP, nosniff and Referrer-Policy itself. Next copies proxy response headers
 * onto the outgoing response before the route handler runs, and
 * `send-response` then refuses to replace a header that is already present, so
 * a header set here would override the middleware's `frame-ancestors` and
 * break those iframes. A new surface that has to be framed belongs under one of
 * these two prefixes; do not widen the exemption.
 *
 * WHY NO `script-src` / `style-src`. The App Router emits inline flight and
 * hydration scripts, and rendered components carry inline `style` attributes.
 * A script policy would need `'unsafe-inline'` or a per-request nonce, which
 * forces every page into dynamic rendering. `object-src` and `base-uri` are
 * safe to lock down: the operator UI renders no `<object>`, `<embed>` or
 * `<base>`.
 */

/** Env knob: the CSP `frame-ancestors` source list for operator pages. */
export const FRAME_ANCESTORS_ENV_KEY = 'UI_FRAME_ANCESTORS';

/** Route-handler prefixes whose (partly framed) responses come from the middleware. */
const FRAMED_PROXY_PREFIXES = ['/p', '/bot-api'] as const;

const NONE = "'none'";
const SELF = "'self'";

/** CSP keyword sources are case-insensitive; normalise them on the way in. */
const KEYWORD_SOURCE = /^'(self|none)'$/i;
/** `https:` — a scheme-source. */
const SCHEME_SOURCE = /^[a-z][a-z0-9+.-]*:$/i;
/** `[scheme://](*|[*.]host)[:port][/path]` — a host-source. Deliberately no
 *  `;`, `,` or quotes anywhere, so a value can never add another directive. */
const HOST_SOURCE =
  /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(?:\*|\d{1,5}))?(?:\/[^\s;,'"]*)?$/i;
/** Anything but printable ASCII, space and tab makes the whole value invalid. */
const DISALLOWED_CHARACTER = /[^\x20-\x7e\t]/;

export type SecurityHeader = readonly [name: string, value: string];

export type FrameAncestorsSetting =
  | { readonly kind: 'default' }
  | { readonly kind: 'custom'; readonly sources: string }
  | { readonly kind: 'invalid'; readonly raw: string };

type HeaderEnv = Readonly<Record<string, string | undefined>>;

/** True for `/p`, `/p/…`, `/bot-api` and `/bot-api/…` — segment-exact. */
export function isFramedProxyPath(pathname: string): boolean {
  return FRAMED_PROXY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Parse `UI_FRAME_ANCESTORS`. Unset, empty and an explicit `'none'` mean the
 * default. Anything that is not a whitespace-separated list of CSP source
 * expressions is `invalid`, which callers must treat as the default: a typo
 * must never open the UI to framing.
 */
export function parseFrameAncestors(raw: string | undefined): FrameAncestorsSetting {
  const trimmed = raw?.trim() ?? '';
  if (trimmed.length === 0) return { kind: 'default' };
  if (DISALLOWED_CHARACTER.test(trimmed)) return { kind: 'invalid', raw: raw ?? '' };

  const sources = trimmed.split(/\s+/).map((token) => normaliseSource(token));
  if (sources.some((source) => source === null)) return { kind: 'invalid', raw: raw ?? '' };
  if (sources.includes(NONE)) {
    return sources.length === 1 ? { kind: 'default' } : { kind: 'invalid', raw: raw ?? '' };
  }
  return { kind: 'custom', sources: sources.join(' ') };
}

function normaliseSource(token: string): string | null {
  const keyword = KEYWORD_SOURCE.exec(token);
  if (keyword) return (keyword[1] ?? '').toLowerCase() === 'self' ? SELF : NONE;
  if (SCHEME_SOURCE.test(token) || HOST_SOURCE.test(token)) return token;
  return null;
}

let lastWarnedValue: string | undefined;

function warnInvalidOnce(raw: string): void {
  if (lastWarnedValue === raw) return;
  lastWarnedValue = raw;
  console.warn(
    `[web-ui] ignoring ${FRAME_ANCESTORS_ENV_KEY}=${JSON.stringify(raw)}: expected a ` +
      "space-separated list of CSP sources such as 'self' https://portal.example.com; " +
      "operator pages keep frame-ancestors 'none'.",
  );
}

/** The header set for an operator page, read from `env` on every call. */
export function operatorUiSecurityHeaders(
  env: HeaderEnv = process.env,
): readonly SecurityHeader[] {
  const setting = parseFrameAncestors(env[FRAME_ANCESTORS_ENV_KEY]);
  if (setting.kind === 'invalid') warnInvalidOnce(setting.raw);

  const frameAncestors = setting.kind === 'custom' ? setting.sources : NONE;
  const csp: SecurityHeader = [
    'Content-Security-Policy',
    `frame-ancestors ${frameAncestors}; object-src 'none'; base-uri 'none'`,
  ];
  // X-Frame-Options can only say DENY or SAMEORIGIN, never an allowlist, so
  // it is sent only while framing is refused outright.
  const frameOptions: readonly SecurityHeader[] =
    setting.kind === 'custom' ? [] : [['X-Frame-Options', 'DENY']];
  return [
    csp,
    ...frameOptions,
    ['X-Content-Type-Options', 'nosniff'],
    ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ];
}

/**
 * Put the operator-UI headers on a response the proxy just created, unless the
 * path is one of the framed proxy prefixes. Returns the same response.
 */
export function applyOperatorUiSecurityHeaders<T extends Response>(
  pathname: string,
  response: T,
  env: HeaderEnv = process.env,
): T {
  if (isFramedProxyPath(pathname)) return response;
  for (const [name, value] of operatorUiSecurityHeaders(env)) {
    response.headers.set(name, value);
  }
  return response;
}
