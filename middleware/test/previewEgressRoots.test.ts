/**
 * ADR-0017 — a Builder preview's own requests are judged by the egress guard
 * like an installed plugin's: by its draft manifest while the preview is open,
 * with no network at all once it is closed.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { attributeStack, decideEgress } from '../src/platform/pluginEgressGuard.js';
import {
  UNREGISTERED_PREVIEW_ID,
  createPreviewEgressRoots,
} from '../src/platform/previewEgressRoots.js';

const ROOT = '/data/builder/.previews';
const frameIn = (file: string): string => `Error\n    at fetchIt (${file}:3:7)`;

describe('preview egress roots', () => {
  it('attributes a draft frame to its preview and applies the manifest hosts', () => {
    const previews = createPreviewEgressRoots(ROOT);
    previews.register({
      packageRoot: `${ROOT}/d1-3/pkg`,
      agentId: '@acme/crm',
      network: { outbound: ['api.example.com'], publicWeb: false },
    });
    const id = attributeStack(frameIn(`${ROOT}/d1-3/pkg/dist/index.js`), previews.roots());
    assert.ok(id?.startsWith('preview:@acme/crm#'), id);
    const permission = previews.permissionOf(id);
    assert.ok(permission);
    assert.equal(permission.isModelPlugin, false);
    assert.equal(decideEgress(permission, 'api.example.com', new Set()), undefined);
    assert.equal(decideEgress(permission, 'evil.example.net', new Set()), 'not_allowed');
    assert.equal(decideEgress(permission, 'api.anthropic.com', new Set(['api.anthropic.com'])), 'model_provider');
  });

  it('gives an unregistered extract under the previews root no network', () => {
    const previews = createPreviewEgressRoots(ROOT);
    const unregister = previews.register({
      packageRoot: `${ROOT}/d2-1`,
      agentId: 'x',
      network: { outbound: ['api.example.com'], publicWeb: false },
    });
    unregister();
    const id = attributeStack(frameIn(`${ROOT}/d2-1/dist/index.js`), previews.roots());
    assert.equal(id, UNREGISTERED_PREVIEW_ID);
    const permission = previews.permissionOf(UNREGISTERED_PREVIEW_ID);
    assert.ok(permission);
    assert.equal(decideEgress(permission, 'api.example.com', new Set()), 'not_allowed');
  });

  it('never resolves an installed plugin id', () => {
    const previews = createPreviewEgressRoots(ROOT);
    assert.equal(previews.permissionOf('@acme/crm'), undefined);
  });

  it('leaves kernel frames outside the previews root to the kernel', () => {
    const previews = createPreviewEgressRoots(ROOT);
    assert.equal(attributeStack(frameIn('/app/middleware/dist/index.js'), previews.roots()), undefined);
  });
});
