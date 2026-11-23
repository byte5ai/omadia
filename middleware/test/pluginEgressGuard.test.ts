/**
 * Spec 2042 §5.10, §6 criterion 37 — the network sandbox of plugins.
 *
 *   - a plugin's effective network permission is its manifest hosts, the
 *     operator's hosts and `public-web`, minus model providers (unless it is
 *     a model plugin);
 *   - the request is the plugin's when its own code makes it; a request the
 *     kernel makes on its behalf (`ctx.http`, `ctx.llm`) is the kernel's;
 *   - `observe` lets it through and records it once, `enforce` refuses it,
 *     through the global `fetch` and `node:http(s)` alike.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, afterEach, before, describe, it } from 'node:test';

import express from 'express';

import { createModelGatewayStatusRouter } from '../src/routes/modelGatewayStatus.js';
import {
  PluginEgressRefusedError,
  attributeStack,
  decideEgress,
  installPluginEgressGuard,
  pluginEgressObservations,
  resetPluginEgressGuardForTests,
  type PluginEgressPermission,
} from '../src/platform/pluginEgressGuard.js';

const MODEL_HOSTS = new Set(['api.anthropic.com', 'api.openai.com']);
const perm = (p: Partial<PluginEgressPermission>): PluginEgressPermission => ({
  isModelPlugin: false,
  hosts: [],
  publicWeb: false,
  ...p,
});

describe('effective network permission', () => {
  it('allows the manifest hosts, wildcards one label deep', () => {
    const p = perm({ hosts: ['api.example.com', '*.botframework.com'] });
    assert.equal(decideEgress(p, 'api.example.com', MODEL_HOSTS), undefined);
    assert.equal(decideEgress(p, 'smba.botframework.com', MODEL_HOSTS), undefined);
    assert.equal(decideEgress(p, 'a.b.botframework.com', MODEL_HOSTS), 'not_allowed');
    assert.equal(decideEgress(p, 'evil.example.org', MODEL_HOSTS), 'not_allowed');
  });

  it('never reaches a model provider, not even listed or in public-web mode', () => {
    assert.equal(decideEgress(perm({ hosts: ['api.anthropic.com'] }), 'api.anthropic.com', MODEL_HOSTS), 'model_provider');
    assert.equal(decideEgress(perm({ publicWeb: true }), 'API.OpenAI.com', MODEL_HOSTS), 'model_provider');
  });

  it('lets a model plugin reach its provider', () => {
    assert.equal(decideEgress(perm({ isModelPlugin: true, hosts: ['api.anthropic.com'] }), 'api.anthropic.com', MODEL_HOSTS), undefined);
  });

  it('public-web: any public host, no literal private address', () => {
    const p = perm({ publicWeb: true });
    assert.equal(decideEgress(p, 'www.example.com', MODEL_HOSTS), undefined);
    assert.equal(decideEgress(p, '93.184.216.34', MODEL_HOSTS), undefined);
    assert.equal(decideEgress(p, '10.0.0.5', MODEL_HOSTS), 'private_address');
    assert.equal(decideEgress(p, '[::1]', MODEL_HOSTS), 'private_address');
    assert.equal(decideEgress(p, 'localhost', MODEL_HOSTS), 'private_address');
    assert.equal(decideEgress(p, 'app.localhost', MODEL_HOSTS), 'private_address');
  });
});

describe('who makes the request', () => {
  const roots = [{ root: '/data/plugins/@acme/notion/1.0.0', pluginId: '@acme/notion' }];

  it('is the plugin when its code (or its own dependency) is the innermost caller', () => {
    const stack = [
      'Error',
      '    at check (/app/middleware/dist/platform/pluginEgressGuard.js:10:5)',
      '    at fetch (/app/middleware/dist/platform/pluginEgressGuard.js:20:5)',
      '    at Client.request (/data/plugins/@acme/notion/1.0.0/node_modules/@notionhq/client/build/index.js:5:1)',
      '    at async sync (/data/plugins/@acme/notion/1.0.0/dist/plugin.js:9:3)',
    ].join('\n');
    assert.equal(attributeStack(stack, roots), '@acme/notion');
  });

  it('skips the kernel’s dependencies to their caller', () => {
    const stack = [
      'Error',
      '    at Anthropic.post (/app/middleware/node_modules/@anthropic-ai/sdk/client.js:1:1)',
      '    at async summarise (file:///data/plugins/@acme/notion/1.0.0/dist/plugin.js:3:1)',
    ].join('\n');
    assert.equal(attributeStack(stack, roots), '@acme/notion');
  });

  it('is the kernel when kernel code calls on the plugin’s behalf', () => {
    const stack = [
      'Error',
      '    at Anthropic.post (/app/middleware/node_modules/@anthropic-ai/sdk/client.js:1:1)',
      '    at async complete (/app/middleware/dist/platform/pluginContext.js:1880:7)',
      '    at async summarise (/data/plugins/@acme/notion/1.0.0/dist/plugin.js:3:1)',
    ].join('\n');
    assert.equal(attributeStack(stack, roots), undefined);
  });

  it('takes the kernel’s own packages for kernel code, wherever they are installed', () => {
    const stack = [
      'Error',
      '    at Anthropic.post (/opt/omadia/node_modules/@anthropic-ai/sdk/client.js:1:1)',
      '    at async chat (/opt/omadia/node_modules/@omadia/orchestrator/dist/orchestrator.js:9:1)',
      '    at async onMessage (/data/plugins/@acme/notion/1.0.0/dist/plugin.js:3:1)',
    ].join('\n');
    assert.equal(attributeStack(stack, roots), undefined);
  });

  it('does not take a sibling directory for the package', () => {
    const stack = ['Error', '    at x (/data/plugins/@acme/notion/1.0.0-evil/plugin.js:1:1)'].join('\n');
    assert.equal(attributeStack(stack, roots), undefined);
  });
});

describe('the guard on fetch and node:http', () => {
  let server: http.Server;
  let base = '';
  let dir = '';
  let plugin: {
    callFetch: (url: string) => Promise<Response>;
    callFetchLater: (url: string) => Promise<Response>;
    callHttp: (url: string) => Promise<number>;
  };

  before(async () => {
    server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
    dir = mkdtempSync(path.join(tmpdir(), 'egress-plugin-'));
    const file = path.join(dir, 'plugin.mjs');
    writeFileSync(
      file,
      [
        "import { get } from 'node:http';",
        'export async function callFetch(url) { return fetch(url); }',
        'export async function callFetchLater(url) { await new Promise((r) => setTimeout(r, 5)); await null; return fetch(url); }',
        'export function callHttp(url) {',
        '  return new Promise((resolve, reject) => {',
        '    try { get(url, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject); }',
        '    catch (err) { reject(err); }',
        '  });',
        '}',
      ].join('\n'),
    );
    plugin = (await import(pathToFileURL(file).href)) as typeof plugin;
  });

  after(async () => {
    resetPluginEgressGuardForTests();
    rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  afterEach(() => resetPluginEgressGuardForTests());

  function install(mode: 'observe' | 'enforce', permission: Partial<PluginEgressPermission> = {}): void {
    installPluginEgressGuard({
      mode,
      source: {
        pluginRoots: () => [
          { root: dir, pluginId: '@acme/plugin' },
          { root: realpathSync(dir), pluginId: '@acme/plugin' },
        ],
        permissionOf: () => perm(permission),
        modelProviderHosts: () => MODEL_HOSTS,
      },
    });
  }

  it('enforce: refuses a plugin’s own fetch to a model provider before any network', async () => {
    install('enforce', { hosts: ['api.anthropic.com'] });
    await assert.rejects(plugin.callFetch('https://api.anthropic.com/v1/messages'), (err: unknown) => {
      assert.ok(err instanceof PluginEgressRefusedError);
      assert.equal(err.reason, 'model_provider');
      assert.equal(err.pluginId, '@acme/plugin');
      return true;
    });
  });

  it('enforce: refuses node:http to a host outside the permission', async () => {
    install('enforce');
    await assert.rejects(plugin.callHttp(base), (err: unknown) => err instanceof PluginEgressRefusedError && err.reason === 'not_allowed');
  });

  it('enforce: attributes a request made after awaits inside the plugin', async () => {
    install('enforce');
    await assert.rejects(plugin.callFetchLater(base), (err: unknown) => err instanceof PluginEgressRefusedError);
  });

  it('a fault of the guard itself lets the request through', async () => {
    installPluginEgressGuard({
      mode: 'enforce',
      source: {
        pluginRoots: () => {
          throw new Error('catalog unavailable');
        },
        permissionOf: () => undefined,
        modelProviderHosts: () => MODEL_HOSTS,
      },
    });
    assert.equal((await plugin.callFetch(base)).status, 200);
  });

  it('enforce: lets a covered host through', async () => {
    install('enforce', { hosts: ['127.0.0.1'] });
    assert.equal((await plugin.callFetch(base)).status, 200);
    assert.equal(await plugin.callHttp(base), 200);
  });

  it('enforce: the kernel’s own request is not the plugin’s', async () => {
    install('enforce');
    assert.equal((await fetch(base)).status, 200);
  });

  it('observe: lets the request through and records it once with a count', async () => {
    install('observe');
    assert.equal((await plugin.callFetch(base)).status, 200);
    assert.equal((await plugin.callFetch(base)).status, 200);
    assert.deepEqual(pluginEgressObservations(), [
      { pluginId: '@acme/plugin', host: '127.0.0.1', reason: 'not_allowed', count: 2 },
    ]);
  });

  it('reports what it observed on GET /api/v1/admin/model-gateway', async () => {
    install('observe');
    await plugin.callFetch(base);
    const app = express();
    app.use('/api/v1/admin/model-gateway', createModelGatewayStatusRouter());
    const status = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${String((status.address() as AddressInfo).port)}/api/v1/admin/model-gateway`);
      const body = (await res.json()) as { plugin_egress: { mode: string; observations: unknown[] } };
      assert.equal(body.plugin_egress.mode, 'observe');
      assert.deepEqual(body.plugin_egress.observations, [
        { plugin_id: '@acme/plugin', host: '127.0.0.1', reason: 'not_allowed', count: 1 },
      ]);
    } finally {
      await new Promise<void>((resolve) => status.close(() => resolve()));
    }
  });
});

describe('direct HTTP to a model provider from archetype and capability plugins (criterion 37)', () => {
  type DirectCaller = {
    readonly viaHttps: (url: string) => Promise<number>;
    readonly viaHttp: (url: string) => Promise<number>;
  };
  const permissions: Record<string, PluginEgressPermission> = {
    // An archetype plugin in `public-web` mode that also lists the provider.
    '@acme/archetype': perm({ publicWeb: true, hosts: ['api.anthropic.com'] }),
    // A capability plugin that lists providers as ordinary outbound hosts.
    '@acme/capability': perm({ hosts: ['api.openai.com', 'api.anthropic.com'] }),
  };
  const dirs = new Map<string, string>();
  const plugins = new Map<string, DirectCaller>();

  before(async () => {
    for (const pluginId of Object.keys(permissions)) {
      const dir = mkdtempSync(path.join(tmpdir(), 'egress-model-'));
      const file = path.join(dir, 'plugin.mjs');
      writeFileSync(
        file,
        [
          "import https from 'node:https';",
          "import { request as httpRequest } from 'node:http';",
          'const call = (fn, url) => new Promise((resolve, reject) => {',
          '  try { const req = fn(url, { method: "POST" }, (res) => { res.resume(); resolve(res.statusCode); }); req.on("error", reject); req.end("{}"); }',
          '  catch (err) { reject(err); }',
          '});',
          'export const viaHttps = (url) => call(https.request, url);',
          'export const viaHttp = (url) => call(httpRequest, url);',
        ].join('\n'),
      );
      dirs.set(pluginId, dir);
      plugins.set(pluginId, (await import(pathToFileURL(file).href)) as DirectCaller);
    }
    installPluginEgressGuard({
      mode: 'enforce',
      source: {
        pluginRoots: () =>
          [...dirs].flatMap(([pluginId, root]) => [
            { root, pluginId },
            { root: realpathSync(root), pluginId },
          ]),
        permissionOf: (pluginId) => permissions[pluginId],
        modelProviderHosts: () => MODEL_HOSTS,
      },
    });
  });

  after(() => {
    resetPluginEgressGuardForTests();
    for (const dir of dirs.values()) rmSync(dir, { recursive: true, force: true });
  });

  for (const pluginId of Object.keys(permissions)) {
    it(`criterion 37: ${pluginId} reaches no model provider through node:https or node:http`, async () => {
      const plugin = plugins.get(pluginId);
      assert.ok(plugin);
      const attempts: ReadonlyArray<readonly [(url: string) => Promise<number>, string]> = [
        [plugin.viaHttps, 'https://api.anthropic.com/v1/messages'],
        [plugin.viaHttp, 'http://api.openai.com/v1/chat/completions'],
      ];
      for (const [call, url] of attempts) {
        await assert.rejects(call(url), (err: unknown) => {
          assert.ok(err instanceof PluginEgressRefusedError, String(err));
          assert.equal(err.reason, 'model_provider');
          assert.equal(err.pluginId, pluginId);
          return true;
        });
      }
    });
  }
});
