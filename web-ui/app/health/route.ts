import { APP_VERSION, UNKNOWN_VERSION } from '../_lib/appVersion';

// Fly.io health-check endpoint. Not a page — returns plain JSON so the
// check never accidentally returns HTML that looks 2xx but isn't alive.
//
// It also reports the build identity, which is what lets the self-update
// (#432) gate on THIS app the way it already gates on the middleware. Without
// a version here, a web-ui that came up on the wrong image — or did not come
// up at all — was invisible: the middleware reported the new version, the
// gate was satisfied, and the update was called landed.
//
// `force-dynamic` is load-bearing. `OMADIA_VERSION` is stamped into the
// RUNTIME stage of web-ui/Dockerfile, so it does not exist while Next
// prerenders; a statically rendered route would bake in `unknown` forever.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({
    status: 'ok',
    service: 'odoo-bot-harness',
    // Null rather than the string "unknown": the updater's health waiter
    // treats a missing version as "cannot verify" and falls back to plain
    // reachability, which is exactly right for an unstamped local build.
    version: APP_VERSION === UNKNOWN_VERSION ? null : APP_VERSION,
  });
}
