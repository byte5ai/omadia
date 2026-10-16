import { APP_VERSION } from '../_lib/appVersion';

// Fly.io and Compose health-check endpoint. Not a page — returns plain JSON so
// the check never accidentally returns HTML that looks 2xx but isn't alive.
// Static liveness on purpose: it must not fail just because the middleware is
// down. `version` is the build stamp (#1382), the same field the middleware's
// /health reports, so a script can tell which image is actually serving.
// Rendered per request, never at build time: a prerendered body would carry
// the build machine's (unset) version instead of the image's stamp.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'ok', service: 'omadia-web-ui', version: APP_VERSION });
}
