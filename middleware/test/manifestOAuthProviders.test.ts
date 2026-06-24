/**
 * Spec 005 T21 — verifies `adaptManifestV1` parses + validates the top-level
 * `oauth_providers:` block onto `Plugin.oauth_providers`, sets the
 * `permissions_summary.acquires_oauth` signal, and drops malformed descriptors
 * (graceful-degradation) without failing the whole manifest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';

function manifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1',
    identity: {
      id: 'de.byte5.integration.test',
      kind: 'integration',
      domain: 'test',
      name: 'Test Integration',
      version: '1.0.0',
    },
    ...extra,
  };
}

const atlassian = {
  id: 'atlassian',
  authorize_url: 'https://auth.atlassian.com/authorize',
  token_url: 'https://auth.atlassian.com/oauth/token',
  token_auth_style: 'body_json',
  extra_authorize_params: { audience: 'api.atlassian.com', prompt: 'consent' },
  client_id_field: 'client_id',
  client_secret_field: 'client_secret',
};

test('absent oauth_providers → field omitted, acquires_oauth false', () => {
  const plugin = adaptManifestV1(manifest());
  assert.ok(plugin);
  assert.equal(plugin.oauth_providers, undefined);
  assert.equal(plugin.permissions_summary.acquires_oauth, false);
});

test('parses a valid descriptor + sets acquires_oauth', () => {
  const plugin = adaptManifestV1(manifest({ oauth_providers: [atlassian] }));
  assert.ok(plugin);
  assert.equal(plugin.permissions_summary.acquires_oauth, true);
  assert.ok(plugin.oauth_providers);
  assert.equal(plugin.oauth_providers.length, 1);
  const d = plugin.oauth_providers[0]!;
  assert.equal(d.id, 'atlassian');
  assert.equal(d.token_auth_style, 'body_json');
  assert.equal(d.pkce, true, 'pkce defaults to true');
  assert.deepEqual(d.extra_authorize_params, {
    audience: 'api.atlassian.com',
    prompt: 'consent',
  });
  assert.equal(d.client_secret_field, 'client_secret');
});

test('pkce honors explicit false; extra_authorize_params keeps only strings', () => {
  const plugin = adaptManifestV1(
    manifest({
      oauth_providers: [
        {
          ...atlassian,
          pkce: false,
          extra_authorize_params: { audience: 'api.atlassian.com', n: 5 },
        },
      ],
    }),
  );
  assert.ok(plugin?.oauth_providers);
  const d = plugin.oauth_providers[0]!;
  assert.equal(d.pkce, false);
  assert.deepEqual(d.extra_authorize_params, { audience: 'api.atlassian.com' });
});

test('drops descriptor missing required keys but keeps valid siblings', () => {
  const plugin = adaptManifestV1(
    manifest({
      oauth_providers: [
        { id: 'broken', authorize_url: 'https://x/y' }, // no token_url etc.
        atlassian,
      ],
    }),
  );
  assert.ok(plugin?.oauth_providers);
  assert.equal(plugin.oauth_providers.length, 1);
  assert.equal(plugin.oauth_providers[0]!.id, 'atlassian');
});

test('drops descriptor with an invalid token_auth_style', () => {
  const plugin = adaptManifestV1(
    manifest({
      oauth_providers: [{ ...atlassian, token_auth_style: 'header_magic' }],
    }),
  );
  assert.ok(plugin);
  assert.equal(plugin.oauth_providers, undefined);
  assert.equal(plugin.permissions_summary.acquires_oauth, false);
});
