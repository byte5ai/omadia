/**
 * Why the plugin UI iframe is same-origin (epic #470 C8b).
 *
 * The frame shipped as `sandbox="allow-scripts allow-forms allow-popups"` —
 * no `allow-same-origin`. That gives the document an OPAQUE origin, and the
 * consequence is not a browser detail, it is this file's subject: core issues
 * its operator session as `SameSite=Lax`, and a `SameSite=Lax` cookie is not
 * attached to a request from an opaque origin. Every screen of a data-driven
 * plugin UI opens with a GET, so the frame rendered an error state and nothing
 * in either repo's suite noticed, because both stub `fetch` and a stub has no
 * origin.
 *
 * These tests assert the two halves of the posture the decision rests on:
 *
 *   1. The session cookie really is `SameSite=Lax; Path=/` — so a SAME-origin
 *      subresource request from the framed document carries it, and no
 *      `SameSite=None; Secure` loosening of the product-wide cookie is needed
 *      to make one iframe work.
 *   2. The document core serves at `/p/<id>/ui/` is confined by a CSP that
 *      permits exactly that same-origin call (`connect-src 'self'`) and
 *      nothing wider — which is what makes granting `allow-same-origin`
 *      defensible rather than merely convenient.
 *
 * The reasoning in full: `plan.md` §4.3a addendum, in the epic #470 spec
 * directory.
 */

import { after, before, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';

import type { AuthProvider } from '../src/auth/providers/AuthProvider.js';
import { ProviderRegistry } from '../src/auth/providerRegistry.js';
import { createRequireAuth } from '../src/auth/requireAuth.js';
import type { UserStore } from '../src/auth/userStore.js';
import { EmailWhitelist } from '../src/auth/whitelist.js';
import { createAuthRouter } from '../src/routes/auth.js';
import { createPluginUiStaticRouter } from '../src/routes/pluginUiStatic.js';
import { invoke } from './_helpers/httpInvoke.js';

const PLUGIN_ID = '@omadia/example-ui';
const SIGNING_KEY = new Uint8Array(32).fill(7);
const OPERATOR = 'operator@example.com';

/**
 * A password provider that always succeeds. The session MINT is the subject
 * here, not credential verification — that has its own tests.
 */
const provider: AuthProvider = {
  id: 'local',
  displayName: 'Local',
  kind: 'password',
  verify: async () => ({
    outcome: 'success' as const,
    providerUserId: OPERATOR,
    email: OPERATOR,
    displayName: 'Operator',
  }),
};

let root: string;
let app: Express;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-ui-creds-'));
  const packageRoot = path.join(root, 'packages', 'example-ui', '1.0.0');
  await fs.mkdir(path.join(packageRoot, 'ui'), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, 'ui', 'index.html'),
    '<!doctype html><title>bundle</title>',
  );

  const registry = new ProviderRegistry();
  registry.register(provider);

  app = express();
  app.use(cookieParser());
  app.use(
    '/api/v1/auth',
    createAuthRouter({
      registry,
      userStore: {
        count: async () => 1,
        markLoginNow: async () => undefined,
      } as unknown as UserStore,
      signingKey: SIGNING_KEY,
      publicBaseUrl: 'https://omadia.example',
      defaultReturnPath: '/',
      setupAllowed: false,
    }),
  );
  // The document the operator's browser frames.
  app.use(
    '/p',
    createPluginUiStaticRouter({
      resolvePackageRoot: (id) => (id === PLUGIN_ID ? packageRoot : undefined),
    }),
  );
  // Stand-in for the plugin's own authenticated backend router — the thing the
  // framed document GETs on every screen.
  app.use(
    '/api/v1/plugin',
    createRequireAuth({ signingKey: SIGNING_KEY, whitelist: new EmailWhitelist('') }),
    (req, res) => {
      res.json({ ok: true, sub: req.session?.sub });
    },
  );
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function login(): Promise<string> {
  const res = await invoke(app, 'POST', '/api/v1/auth/login/local');
  assert.equal(res.status, 200);
  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw.map(String) : [String(raw)];
  const session = cookies.find((c) => c.startsWith('omadia_session='));
  assert.ok(session, 'login did not set a session cookie');
  return session;
}

describe('plugin UI frame credentials — session cookie posture', () => {
  it('issues the operator session as SameSite=Lax, Path=/, HttpOnly', async () => {
    const cookie = await login();
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /HttpOnly/i);
  });

  it('does NOT ship SameSite=None, which an opaque-origin frame would require', async () => {
    // The alternative trust model — keep the sandbox opaque, make the cookie
    // cross-site — would mean loosening the session cookie for the ENTIRE
    // product to serve one iframe. This assertion is the record that we did
    // not, and the tripwire if anyone tries.
    const cookie = await login();
    assert.doesNotMatch(cookie, /SameSite=None/i);
  });

  it('authenticates a same-origin request that replays that cookie', async () => {
    // A same-SITE request carries a SameSite=Lax cookie. `allow-same-origin`
    // on the frame is exactly what makes the framed document's fetch same-site
    // rather than `Origin: null`.
    const cookie = (await login()).split(';')[0] ?? '';
    const res = await invoke(app, 'GET', '/api/v1/plugin/jobs', {
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    assert.equal((JSON.parse(res.text) as { sub?: string }).sub, OPERATOR);
  });

  it('401s the same request without the cookie — the opaque-origin outcome', async () => {
    // Mutation guard: without this, the assertion above could pass against a
    // route that never checked anything.
    const res = await invoke(app, 'GET', '/api/v1/plugin/jobs');
    assert.equal(res.status, 401);
  });
});

describe('plugin UI frame credentials — the served document stays confined', () => {
  const bundleRoot = `/p/${encodeURIComponent(PLUGIN_ID)}/ui/`;

  it("permits the same-origin call it now depends on, via connect-src 'self'", async () => {
    const res = await invoke(app, 'GET', bundleRoot);
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-security-policy']), /connect-src 'self'/);
  });

  it('keeps the directives that make allow-same-origin defensible', async () => {
    const csp = String(
      (await invoke(app, 'GET', bundleRoot)).headers['content-security-policy'],
    );
    // No remote script, no off-site framing, no base-tag or form-action
    // escape. The bundle now holds the operator's session, so THESE are the
    // boundary — not the sandbox attribute.
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.doesNotMatch(csp, /unsafe-eval/);
  });

  it('serves the scoped plugin id the host page now accepts', async () => {
    // Companion to the web-ui regex fix: the id travels percent-encoded as ONE
    // path segment and Express decodes it, so `@omadia/example-ui` resolves
    // here. If either half of that round-trip changes, this goes red.
    const res = await invoke(app, 'GET', `${bundleRoot}index.html`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  });
});
