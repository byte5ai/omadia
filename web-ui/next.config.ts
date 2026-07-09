import path from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

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

  // NB: /bot-api/* and /p/* are deliberately NOT rewrites. Next evaluates
  // rewrites() at build time and freezes the destination into
  // routes-manifest.json, which baked the compose hostname into the
  // published Docker image and broke MIDDLEWARE_URL as a runtime setting
  // on every other platform. They are route handlers now
  // (app/bot-api/[[...path]]/route.ts, app/p/[[...path]]/route.ts) that
  // resolve MIDDLEWARE_URL per request — see app/_lib/middlewareProxy.ts.
  async rewrites() {
    return [
      // Friction-free pairing discovery (#293). `.well-known` segments are
      // ignored by the App Router file system, so the canonical public path is
      // served by the `/pairing-discovery` route handler via this rewrite. The
      // desktop app GETs the operator URL it already knows and gets back a
      // connect-ready descriptor (absolute wsUrl + auth). Static destination,
      // so the build-time freeze is harmless here.
      {
        source: '/.well-known/omadia-ui',
        destination: '/pairing-discovery',
      },
    ];
  },
};

export default withNextIntl(nextConfig);
