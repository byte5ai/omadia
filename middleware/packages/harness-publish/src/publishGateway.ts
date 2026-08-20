import * as http from 'node:http';

/**
 * Issue #581 — the origin boundary published apps run behind.
 *
 * This is NOT a deployment detail; it is a security boundary. Cookies are
 * scoped by the browser to a request's HOST (RFC 6265 does not consider the
 * port at all), so an app served on the admin/portal's own hostname — even
 * on a different PORT — could read the admin session cookie and set cookies
 * the admin origin would honor. `PublishGateway` therefore:
 *
 *  1. Only ever serves a request whose `Host` header ends in a dedicated
 *     apps suffix (`appsHostSuffix`, e.g. `.apps.omadia.internal`) that is
 *     NEVER also the admin/portal's own host — any other `Host`, INCLUDING
 *     an exact match on the admin host, is rejected outright before any
 *     app backend is even resolved.
 *  2. Never forwards `Cookie`/`Authorization` headers to the app backend —
 *     an app has no legitimate reason to see the caller's admin session,
 *     and defense in depth beats trusting every future backend to ignore
 *     them.
 *  3. Strips any `Set-Cookie` the app backend tries to send back that
 *     declares an explicit `Domain=` attribute — an app has no legitimate
 *     reason to scope a cookie anywhere other than "wherever the browser
 *     already thinks it is" (the default, un-scoped case), and an explicit
 *     `Domain=` is exactly how a cookie could otherwise be aimed at the
 *     admin host.
 *
 * `resolveTarget` is the only way this module learns where to proxy to —
 * it never imports Docker or any `PublishRuntime` directly, so the gateway
 * itself is fully testable with two plain `http.Server`s and no container
 * runtime at all (see `publishGateway.test.ts`).
 */
export interface PublishGatewayTarget {
  readonly host: string;
  readonly port: number;
}

export interface PublishGatewayOptions {
  /** A request's `Host` header (port stripped) must END with this suffix to
   *  be treated as an app request. Must never equal the admin/portal's own
   *  host — that is the caller's responsibility to configure correctly;
   *  this module only enforces the suffix match. */
  readonly appsHostSuffix: string;
  /** Resolves the app slug (the `Host` header with `appsHostSuffix`
   *  stripped) to where its currently-live version is listening. Returning
   *  `undefined` yields a 404. */
  readonly resolveTarget: (appSlug: string) => Promise<PublishGatewayTarget | undefined>;
}

const HOP_BY_HOP_REQUEST_HEADERS = ['cookie', 'authorization', 'host'];

function stripDomainScopedSetCookie(setCookie: string | string[] | undefined): string[] | undefined {
  if (setCookie === undefined) return undefined;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  const kept = list.filter((entry) => !/;\s*domain\s*=/i.test(entry));
  return kept.length > 0 ? kept : undefined;
}

export function createPublishGateway(options: PublishGatewayOptions): http.Server {
  return http.createServer((req, res) => {
    void handleRequest(req, res, options);
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: PublishGatewayOptions,
): Promise<void> {
  const hostHeader = (req.headers.host ?? '').split(':')[0] ?? '';
  const suffix = options.appsHostSuffix;
  const appSlug = hostHeader.endsWith(suffix) ? hostHeader.slice(0, -suffix.length) : undefined;
  if (!appSlug) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('publish gateway: host is not an apps host');
    return;
  }

  const target = await options.resolveTarget(appSlug);
  if (!target) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('publish gateway: no live version for this app');
    return;
  }

  const forwardedHeaders: http.OutgoingHttpHeaders = { ...req.headers };
  for (const header of HOP_BY_HOP_REQUEST_HEADERS) delete forwardedHeaders[header];

  const proxyReq = http.request(
    { host: target.host, port: target.port, path: req.url, method: req.method, headers: forwardedHeaders },
    (proxyRes) => {
      const responseHeaders: http.OutgoingHttpHeaders = { ...proxyRes.headers };
      const strippedSetCookie = stripDomainScopedSetCookie(proxyRes.headers['set-cookie']);
      if (strippedSetCookie === undefined) delete responseHeaders['set-cookie'];
      else responseHeaders['set-cookie'] = strippedSetCookie;

      res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('publish gateway: upstream app did not respond');
  });
  req.pipe(proxyReq);
}
