import { createMiddlewareProxy } from '@/app/_lib/middlewareProxy';

// Same-origin browser surface for the middleware Admin API: /bot-api/* is
// forwarded to `${MIDDLEWARE_URL}/api/*` at request time. See
// middlewareProxy.ts for why this is a route handler and not a
// next.config.ts rewrite.

const proxy = createMiddlewareProxy('/api');

export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
  proxy as HEAD,
  proxy as OPTIONS,
};
