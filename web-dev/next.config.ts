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
    ];
  },
};

export default withNextIntl(nextConfig);
