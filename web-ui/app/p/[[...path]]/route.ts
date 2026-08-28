import { createMiddlewareProxy } from '@/app/_lib/middlewareProxy';

// Plugin-served UI surfaces: plugins register Express routers under
// /p/<pluginId>/... via ctx.routes.register; iframes embedded in Teams
// Tabs hit this proxy so the browser only ever sees the web-ui origin.
// Forwarded to `${MIDDLEWARE_URL}/p/*` at request time — see
// middlewareProxy.ts for why this is a route handler and not a
// next.config.ts rewrite.

const proxy = createMiddlewareProxy('/p');

export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
  proxy as HEAD,
  proxy as OPTIONS,
};
