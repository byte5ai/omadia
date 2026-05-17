import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import express from 'express';

import type {
  PreviewHandle,
  PreviewRouteCapture,
  PreviewToolDescriptor,
} from '../../src/plugins/builder/previewRuntime.js';
import { invokeToolsOnHandle } from '../../src/plugins/builder/runtimeSmoke.js';

const RENDERED_HTML_BODY = 'x'.repeat(220); // > 200 chars threshold
const TEAMS_CSP =
  "default-src 'self'; frame-ancestors 'self' https://*.teams.microsoft.com";

function uiCapture(
  prefix: string,
  build: (router: ReturnType<typeof express.Router>) => void,
): PreviewRouteCapture {
  const router = express.Router();
  build(router);
  return { prefix, router, disposed: false };
}

function makeHandle(
  routeCaptures: ReadonlyArray<PreviewRouteCapture>,
  tools: ReadonlyArray<PreviewToolDescriptor> = [],
): PreviewHandle {
  return {
    draftId: 'd-1',
    agentId: 'de.byte5.agent.test',
    rev: 1,
    toolkit: { tools },
    previewDir: '/tmp/preview-stub',
    routeCaptures,
    close: async () => undefined,
  };
}

const minSpec = {
  template: 'agent-integration',
  id: 'de.byte5.agent.test',
  name: 'Test',
  version: '0.1.0',
  description: 'fixture',
  category: 'analysis',
  depends_on: [],
  tools: [],
  skill: { role: 'tester' },
  setup_fields: [],
  playbook: { when_to_use: 'tests', not_for: [], example_prompts: [] },
  network: { outbound: [] },
  slots: {},
};

describe('smokeUiRoutes — happy path', () => {
  it('passes when the ui-route returns 200 + HTML + CSP frame-ancestors + body > 200', async () => {
    const handle = makeHandle([
      uiCapture('/p/test.agent', (router) => {
        router.get('/dashboard', (_req, res) => {
          res.setHeader('Content-Security-Policy', TEAMS_CSP);
          res.type('html').send(RENDERED_HTML_BODY);
        });
      }),
    ]);
    const result = await invokeToolsOnHandle({ handle, spec: minSpec });
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'no_tools');
    assert.ok(result.uiRouteResults && result.uiRouteResults.length === 1);
    assert.equal(result.uiRouteResults?.[0]?.status, 'ok');
    assert.equal(result.uiRouteResults?.[0]?.httpStatus, 200);
  });

  it('skips admin-route checks for /p/* captures (no JSON schema_violation)', async () => {
    const handle = makeHandle([
      uiCapture('/p/test.agent', (router) => {
        router.get('/dashboard', (_req, res) => {
          res.setHeader('Content-Security-Policy', TEAMS_CSP);
          res.type('html').send(RENDERED_HTML_BODY);
        });
      }),
    ]);
    const result = await invokeToolsOnHandle({ handle, spec: minSpec });
    // adminRouteResults should be undefined or empty — the /p/* capture
    // is exclusively ui-route territory.
    assert.ok(!result.adminRouteResults || result.adminRouteResults.length === 0);
  });
});

describe('smokeUiRoutes — failure modes', () => {
  it('flags missing_csp when CSP header is absent', async () => {
    const handle = makeHandle([
      uiCapture('/p/test.agent', (router) => {
        router.get('/dashboard', (_req, res) => {
          res.type('html').send(RENDERED_HTML_BODY);
        });
      }),
    ]);
    const result = await invokeToolsOnHandle({ handle, spec: minSpec });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ui_route_render_failed');
    assert.equal(result.uiRouteResults?.[0]?.status, 'missing_csp');
  });

  it('flags missing_csp when CSP lacks frame-ancestors', async () => {
    const handle = makeHandle([
      uiCapture('/p/test.agent', (router) => {
        router.get('/dashboard', (_req, res) => {
          res.setHeader('Content-Security-Policy', "default-src 'self'");
          res.type('html').send(RENDERED_HTML_BODY);
        });
      }),
    ]);
    const result = await invokeToolsOnHandle({ handle, spec: minSpec });
    assert.equal(result.uiRouteResults?.[0]?.status, 'missing_csp');
  });

  it('flags wrong_content_type for JSON response', async () => {
    const handle = makeHandle([
      uiCapture('/p/test.agent', (router) => {
        router.get('/dashboard', (_req, res) => {
          res.setHeader('Content-Security-Policy', TEAMS_CSP);
          res.json({ ok: true });
        });
      }),
    ]);
    const result = await invokeToolsOnHandle({ handle, spec: minSpec });
    assert.equal(result.uiRouteResults?.[0]?.status, 'wrong_content_type');
  });

  it('flags empty_render when body is too short', async () => {
    const handle = makeHandle([
      uiCapture('/p/test.agent', (router) => {
        router.get('/dashboard', (_req, res) => {
          res.setHeader('Content-Security-Policy', TEAMS_CSP);
          res.type('html').send('<html><body>x</body></html>');
        });
      }),
    ]);
    const result = await invokeToolsOnHandle({ handle, spec: minSpec });
    assert.equal(result.uiRouteResults?.[0]?.status, 'empty_render');
  });

  it('flags http_error on 500', async () => {
    const handle = makeHandle([
      uiCapture('/p/test.agent', (router) => {
        router.get('/dashboard', (_req, res) => {
          res.status(500).send('boom');
        });
      }),
    ]);
    const result = await invokeToolsOnHandle({ handle, spec: minSpec });
    assert.equal(result.uiRouteResults?.[0]?.status, 'http_error');
    assert.equal(result.uiRouteResults?.[0]?.httpStatus, 500);
  });
});

describe('smokeUiRoutes — mixed routes', () => {
  it('probes /p/* as ui-route AND /api/foo as admin-route separately', async () => {
    const handle = makeHandle([
      // Admin route — JSON contract
      uiCapture('/api/foo/admin', (router) => {
        router.get('/api/list', (_req, res) => res.json({ ok: true, items: [1, 2] }));
      }),
      // UI route — HTML contract
      uiCapture('/p/test.agent', (router) => {
        router.get('/dashboard', (_req, res) => {
          res.setHeader('Content-Security-Policy', TEAMS_CSP);
          res.type('html').send(RENDERED_HTML_BODY);
        });
      }),
    ]);
    const result = await invokeToolsOnHandle({ handle, spec: minSpec });
    assert.equal(result.ok, true);
    assert.equal(result.adminRouteResults?.length, 1);
    assert.equal(result.uiRouteResults?.length, 1);
    assert.equal(result.adminRouteResults?.[0]?.status, 'ok');
    assert.equal(result.uiRouteResults?.[0]?.status, 'ok');
  });

  it('reason=ui_route_render_failed wins over admin_route_schema_violation? no — admin checked first', async () => {
    // Admin-route schema-violation + ui-route render-failure → reason
    // is admin first (it ran first in invokeToolsOnHandle's pipeline).
    // Documents the precedence rule explicitly.
    const handle = makeHandle([
      uiCapture('/api/foo/admin', (router) => {
        router.get('/api/list', (_req, res) => res.json({ items: [] })); // no ok field
      }),
      uiCapture('/p/test.agent', (router) => {
        router.get('/dashboard', (_req, res) => res.status(500).send('x'));
      }),
    ]);
    const result = await invokeToolsOnHandle({ handle, spec: minSpec });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'admin_route_schema_violation');
  });
});

describe('smokeUiRoutes — no ui-routes', () => {
  it('omits uiRouteResults entirely when no /p/* captures exist', async () => {
    const handle = makeHandle([
      uiCapture('/api/foo/admin', (router) => {
        router.get('/api/list', (_req, res) => res.json({ ok: true, items: [] }));
      }),
    ]);
    const result = await invokeToolsOnHandle({ handle, spec: minSpec });
    assert.equal(result.uiRouteResults, undefined);
  });

  it('omits uiRouteResults when there are zero captures at all', async () => {
    const handle = makeHandle([]);
    const result = await invokeToolsOnHandle({ handle, spec: minSpec });
    assert.equal(result.uiRouteResults, undefined);
    assert.equal(result.reason, 'no_tools');
    assert.equal(result.ok, true);
  });
});

