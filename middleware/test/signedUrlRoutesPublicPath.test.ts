/**
 * Signed-URL download routes must be reachable WITHOUT an operator session.
 *
 * `/documents/dl/<key>?exp=&sig=` (office) and `/diagrams/dl/<key>?exp=&sig=`
 * (diagrams) are opened by channel users — Teams, Telegram — who are never
 * logged into the middleware. Both routers authenticate every request
 * themselves via the HMAC signature, so they register with `auth: 'custom'`,
 * which the kernel only accepts beneath a prefix the manifest declares in
 * `permissions.public_paths` (two segments minimum — hence `/dl`). This test
 * pins BOTH halves of that contract per plugin, so neither can drift on its
 * own: a registration without the declaration would throw at activation in
 * production, a declaration without the registration would silently keep the
 * session gate (the `auth.missing` every download answered before this fix).
 * The signer's URL shape is pinned in `office.test.ts` / `diagramSigning.test.ts`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { activate as activateOffice } from '@omadia/plugin-office';
import { activate as activateDiagrams } from '@omadia/diagrams';
import type { PluginContext } from '@omadia/plugin-api';

import { loadManifestFromPath } from '../src/plugins/manifestLoader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string): string =>
  path.resolve(here, '..', 'packages', name, 'manifest.yaml');

interface Registered {
  prefix: string;
  options: { auth?: string } | undefined;
}

/** The smallest context both plugins accept: config + secrets from a map,
 *  no-op tools/log, and a routes registrar that records what it was asked. */
function fakeContext(values: Record<string, unknown>): {
  ctx: PluginContext;
  registered: Registered[];
} {
  const registered: Registered[] = [];
  const ctx = {
    log: () => undefined,
    config: {
      require: <T>(key: string): T => {
        const v = values[key];
        if (v === undefined) throw new Error(`missing config ${key}`);
        return v as T;
      },
      get: <T>(key: string): T | undefined => values[key] as T | undefined,
    },
    secrets: {
      require: async (key: string): Promise<string> => {
        const v = values[key];
        if (typeof v !== 'string') throw new Error(`missing secret ${key}`);
        return v;
      },
    },
    services: { get: () => undefined, has: () => false },
    tools: { register: () => () => undefined },
    routes: {
      register: (prefix: string, _router: unknown, options?: { auth?: string }) => {
        registered.push({ prefix, options });
        return () => undefined;
      },
    },
  } as unknown as PluginContext;
  return { ctx, registered };
}

const COMMON = {
  public_base_url: 'https://mw.example',
  tigris_bucket: 'b',
  tigris_endpoint: 'https://s3.example',
  aws_access_key_id: 'k',
  aws_secret_access_key: 's',
};

describe('signed-URL routes are served without an operator session', () => {
  it('office registers /documents with auth:"custom" and declares it in public_paths', async () => {
    const { ctx, registered } = fakeContext({
      ...COMMON,
      document_url_secret: 'x'.repeat(32),
    });
    const handle = await activateOffice(ctx);
    await handle.close();
    assert.deepEqual(registered, [{ prefix: '/documents/dl', options: { auth: 'custom' } }]);

    const entry = await loadManifestFromPath(pkg('harness-plugin-office'));
    assert.ok(entry, 'office manifest must parse');
    assert.deepEqual(entry.plugin.permissions_summary.public_paths, ['/documents/dl']);
  });

  it('diagrams registers /diagrams with auth:"custom" and declares it in public_paths', async () => {
    const { ctx, registered } = fakeContext({
      ...COMMON,
      kroki_base_url: 'http://kroki.example',
      diagram_url_secret: 'y'.repeat(32),
    });
    const handle = await activateDiagrams(ctx);
    await handle.close();
    assert.deepEqual(registered, [{ prefix: '/diagrams/dl', options: { auth: 'custom' } }]);

    const entry = await loadManifestFromPath(pkg('harness-diagrams'));
    assert.ok(entry, 'diagrams manifest must parse');
    assert.deepEqual(entry.plugin.permissions_summary.public_paths, ['/diagrams/dl']);
  });
});
