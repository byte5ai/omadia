import path from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const middlewareUrl = process.env.MIDDLEWARE_URL ?? 'http://localhost:3979';

// next-intl plugin: wires `i18n/request.ts` into the Next compile so that
// `getRequestConfig` is invoked on every RSC request and the resolved
// messages reach `<NextIntlClientProvider>`.
const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const nextConfig: NextConfig = {
  // Standalone output trims the Docker runtime image to ~150 MB by bundling
  // only the minimum Node runtime + used node_modules. Required for the
  // Fly.io `odoo-bot-harness` deploy; benign for local dev.
  output: 'standalone',

  // Pin the workspace root so Next doesn't pick up a stray parent lockfile
  // when inferring the workspace (common on macOS if ~/package-lock.json exists).
  outputFileTracingRoot: path.resolve(import.meta.dirname),

  // #133/#178 — `@swc/helpers` is pinned via an `overrides` entry to stabilise
  // dependabot lockfiles. That dedup makes Next's standalone file-trace copy
  // ONLY the CJS build, but the server require-hook loads the ESM helper
  // (`esm/_interop_require_default.js`) → "Cannot find module" crash at boot
  // (the standalone server exits 1 in a loop). Force the whole package into
  // the standalone bundle so both variants are present.
  outputFileTracingIncludes: {
    '/**': ['./node_modules/@swc/helpers/**'],
  },

  // Rewrite /bot-api/* on this Next server to the middleware's /api/* so the
  // browser only ever sees same-origin requests. No CORS dance, no separate
  // API-route proxy. The prefix is /bot-api intentionally — /api/* is reserved
  // for Next's own route handlers, which we don't use here but shouldn't shadow.
  //
  // MIDDLEWARE_URL is environment-dependent:
  //   - dev:     http://localhost:3979              (middleware on same machine)
  //   - on Fly:  http://odoo-bot-middleware.internal:8080
  //             (flycast — private network, no public edge hop)
  async rewrites() {
    return [
      {
        source: '/bot-api/:path*',
        destination: `${middlewareUrl}/api/:path*`,
      },
      // Friction-free pairing discovery (#293). `.well-known` segments are
      // ignored by the App Router file system, so the canonical public path is
      // served by the `/pairing-discovery` route handler via this rewrite. The
      // desktop app GETs the operator URL it already knows and gets back a
      // connect-ready descriptor (absolute wsUrl + auth).
      {
        source: '/.well-known/omadia-ui',
        destination: '/pairing-discovery',
      },
      // Plugin-served UI surfaces. Plugins register Express routers under
      // /p/<pluginId>/... via ctx.routes.register; iframes embedded in
      // Teams Tabs hit this rewrite so the browser only ever sees the
      // web-ui origin.
      {
        source: '/p/:path*',
        destination: `${middlewareUrl}/p/:path*`,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
