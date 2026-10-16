import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  legacyProviderApiKeyVaultKey,
  providerApiKeyVaultKey,
} from '@omadia/llm-provider';
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createAdminSettingsRouter } from '../src/routes/adminSettings.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';

/**
 * /api/v1/admin/settings — the *cross-plugin* config/vault overview. After the
 * per-plugin settings were de-duplicated out of this page (each plugin's own
 * setup.fields editor is now the source of truth), the catalog holds only the
 * shared Anthropic API key, whose secret fans out to three vault scopes. These
 * tests cover that one entry end-to-end: secret set/unset resolution, the
 * fan-out write, the sk-ant- prefix validation, and unknown/not-installed paths.
 */

const ORCH = '@omadia/orchestrator';
const VERIFIER = '@omadia/verifier';
const EXTRAS = '@omadia/orchestrator-extras';

interface Harness {
  server: Server;
  baseUrl: string;
  vault: InMemorySecretVault;
  registry: InMemoryInstalledRegistry;
  reactivated: string[];
  close(): Promise<void>;
}

async function makeHarness(
  installed: Array<{ id: string; config?: Record<string, unknown> }>,
  providers?: Array<{
    id: string;
    label: string;
    policy?: { requiresApiKey?: boolean };
    wireFormat?: string;
    oauth?: unknown;
  }>,
): Promise<Harness> {
  const vault = new InMemorySecretVault();
  const registry = new InMemoryInstalledRegistry();
  for (const p of installed) {
    await registry.register({
      id: p.id,
      installed_version: '0.1.0',
      installed_at: new Date().toISOString(),
      status: 'active',
      config: p.config ?? {},
    });
  }
  const reactivated: string[] = [];
  const app: Express = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin/settings',
    createAdminSettingsRouter({
      installedRegistry: registry,
      vault,
      reactivate: async (id: string) => {
        reactivated.push(id);
      },
      ...(providers ? { llmProviderCatalog: { list: () => providers } } : {}),
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    vault,
    registry,
    reactivated,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function getSettings(h: Harness): Promise<{
  categories: Array<{
    category: string;
    settings: Array<{
      key: string;
      installed: boolean;
      value?: string | null;
      isSet?: boolean;
      type: string;
    }>;
  }>;
  vault_available: boolean;
}> {
  const res = await fetch(`${h.baseUrl}/api/v1/admin/settings`);
  assert.equal(res.status, 200);
  return res.json() as never;
}

function findSetting(
  body: Awaited<ReturnType<typeof getSettings>>,
  key: string,
): { installed: boolean; value?: string | null; isSet?: boolean; type?: string } | undefined {
  for (const c of body.categories) {
    const s = c.settings.find((x) => x.key === key);
    if (s) return s;
  }
  return undefined;
}

async function patch(
  h: Harness,
  changes: Array<{ key: string; value: string | null }>,
): Promise<{ status: number; body: { updated?: unknown[]; errors?: Array<{ key: string; message: string; code?: string }>; code?: string } }> {
  const res = await fetch(`${h.baseUrl}/api/v1/admin/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ changes }),
  });
  return { status: res.status, body: (await res.json()) as never };
}

describe('admin settings route — GET /', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  it('exposes the shared Anthropic key as an installed secret when all scopes are present', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    const body = await getSettings(h);
    assert.ok(body.vault_available);
    const key = findSetting(body, 'ANTHROPIC_API_KEY');
    assert.equal(key?.installed, true);
    assert.equal(key?.type, 'secret');
    assert.equal(key?.isSet, false);
  });

  it('flags the key not-installed when one scope plugin is missing', async () => {
    // Verifier + extras missing → the cross-plugin secret can't be fully written.
    h = await makeHarness([{ id: ORCH }]);
    const body = await getSettings(h);
    const key = findSetting(body, 'ANTHROPIC_API_KEY');
    assert.equal(key?.installed, false);
  });

  it('reports secret set/unset without leaking the value', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    await h.vault.setMany(ORCH, {
      [providerApiKeyVaultKey('anthropic')]: 'sk-ant-supersecret',
    });
    const body = await getSettings(h);
    const key = findSetting(body, 'ANTHROPIC_API_KEY');
    assert.equal(key?.isSet, true);
    assert.ok(!JSON.stringify(body).includes('sk-ant-supersecret'));
  });
});

describe('admin settings route — PATCH /', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  it('writes the Anthropic secret to every configured vault scope and reactivates each', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    const { status } = await patch(h, [
      { key: 'ANTHROPIC_API_KEY', value: 'sk-ant-test123' },
    ]);
    assert.equal(status, 200);
    for (const scope of [ORCH, VERIFIER, EXTRAS]) {
      const keys = await h.vault.listKeys(scope);
      assert.ok(
        keys.includes(providerApiKeyVaultKey('anthropic')),
        `missing in ${scope}`,
      );
    }
    assert.deepEqual(h.reactivated.sort(), [ORCH, EXTRAS, VERIFIER].sort());
  });

  it('writes the Mistral secret to every scope and accepts a key with no special prefix', async () => {
    // Mistral keys have no public sk-/sk-ant- prefix, so the handler must NOT
    // prefix-validate them — any non-empty value is accepted and fans out to
    // provider:mistral/api_key in all three scopes.
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    const { status, body } = await patch(h, [
      { key: 'MISTRAL_API_KEY', value: 'aB3xY7qP9random32charMistralKeyValue' },
    ]);
    assert.equal(status, 200, JSON.stringify(body));
    for (const scope of [ORCH, VERIFIER, EXTRAS]) {
      const keys = await h.vault.listKeys(scope);
      assert.ok(
        keys.includes(providerApiKeyVaultKey('mistral')),
        `missing in ${scope}`,
      );
    }
    assert.deepEqual(h.reactivated.sort(), [ORCH, EXTRAS, VERIFIER].sort());
  });

  it('exposes the Mistral key as set/unset without leaking its value', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    await h.vault.setMany(ORCH, {
      [providerApiKeyVaultKey('mistral')]: 'mistral-super-secret-value',
    });
    const body = await getSettings(h);
    const key = findSetting(body, 'MISTRAL_API_KEY');
    assert.equal(key?.type, 'secret');
    assert.equal(key?.isSet, true);
    assert.ok(!JSON.stringify(body).includes('mistral-super-secret-value'));
  });

  it('clears BOTH canonical and legacy keys from every scope on an empty value', async () => {
    // Seed an existing install: canonical + the retained legacy fallback. A
    // clear must remove BOTH, else readProviderApiKey keeps resolving the stale
    // legacy key and the revoke is ineffective (Forge S4a #1).
    const legacy = legacyProviderApiKeyVaultKey('anthropic');
    assert.ok(legacy !== undefined);
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    for (const scope of [ORCH, VERIFIER, EXTRAS]) {
      await h.vault.setMany(scope, {
        [providerApiKeyVaultKey('anthropic')]: 'sk-ant-canonical',
        [legacy]: 'sk-ant-legacy',
      });
    }
    const { status } = await patch(h, [{ key: 'ANTHROPIC_API_KEY', value: null }]);
    assert.equal(status, 200);
    for (const scope of [ORCH, VERIFIER, EXTRAS]) {
      const keys = await h.vault.listKeys(scope);
      assert.ok(
        !keys.includes(providerApiKeyVaultKey('anthropic')),
        `canonical still set in ${scope}`,
      );
      assert.ok(!keys.includes(legacy), `legacy still set in ${scope}`);
    }
  });

  it('setting the key deletes the now-redundant legacy key (convergence)', async () => {
    const legacy = legacyProviderApiKeyVaultKey('anthropic');
    assert.ok(legacy !== undefined);
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    for (const scope of [ORCH, VERIFIER, EXTRAS]) {
      await h.vault.setMany(scope, { [legacy]: 'sk-ant-stale-legacy' });
    }
    const { status } = await patch(h, [
      { key: 'ANTHROPIC_API_KEY', value: 'sk-ant-fresh' },
    ]);
    assert.equal(status, 200);
    for (const scope of [ORCH, VERIFIER, EXTRAS]) {
      const keys = await h.vault.listKeys(scope);
      assert.ok(
        keys.includes(providerApiKeyVaultKey('anthropic')),
        `canonical missing in ${scope}`,
      );
      assert.ok(!keys.includes(legacy), `stale legacy survived in ${scope}`);
    }
  });

  it('rejects an Anthropic key without the sk-ant- prefix', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    const { status, body } = await patch(h, [
      { key: 'ANTHROPIC_API_KEY', value: 'nope' },
    ]);
    assert.equal(status, 400);
    // #604: a refused VALUE is not a stale field list. The UI resolves this
    // code to "correct the value"; `settings.no_valid_changes` resolves to
    // "reload the page", which cannot fix a malformed key.
    assert.equal(body.code, 'settings.invalid_values');
    assert.ok(body.errors?.some((e) => e.key === 'ANTHROPIC_API_KEY'));
    assert.deepEqual(h.reactivated, []);
  });

  // The other half of the #604 split: nothing about the VALUE was wrong here,
  // the key is simply not a setting this server offers — so the page's field
  // list is stale and reloading is the action that helps.
  it('errors on an unknown setting key', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }]);
    const { status, body } = await patch(h, [
      { key: 'ORCHESTRATOR_MODEL', value: 'claude-opus-4-8' },
    ]);
    // No longer in the catalog — orchestrator settings moved to the per-plugin editor.
    assert.equal(status, 400);
    assert.equal(body.code, 'settings.no_valid_changes');
    assert.ok(
      body.errors?.some(
        (e) => e.key === 'ORCHESTRATOR_MODEL' && e.message.includes('unknown'),
      ),
    );
  });

  it('errors when a target scope plugin is not installed', async () => {
    h = await makeHarness([{ id: ORCH }]); // verifier + extras missing
    const { status, body } = await patch(h, [
      { key: 'ANTHROPIC_API_KEY', value: 'sk-ant-test123' },
    ]);
    assert.equal(status, 400);
    assert.equal(body.code, 'settings.no_valid_changes');
    assert.ok(
      body.errors?.some(
        (e) =>
          e.key === 'ANTHROPIC_API_KEY' && e.message.includes('not installed'),
      ),
    );
  });
});

describe('admin settings route — runtime-installed provider plugin', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  // The router used to snapshot the catalog at mount, so a provider plugin
  // installed afterwards (no restart) showed on the Providers page but its key
  // was rejected as `unknown setting` (SEIBERTGPT_API_KEY, 2026-10-09).
  it('accepts the API key of a provider registered after the router was mounted', async () => {
    const providers: Array<{ id: string; label: string }> = [];
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }], providers);
    providers.push({ id: 'seibertgpt', label: 'SeibertGPT' });

    const body = await getSettings(h);
    assert.equal(findSetting(body, 'SEIBERTGPT_API_KEY')?.isSet, false);

    const { status } = await patch(h, [{ key: 'SEIBERTGPT_API_KEY', value: 'sgpt_test1234567890' }]);
    assert.equal(status, 200);
    for (const scope of [ORCH, VERIFIER, EXTRAS]) {
      assert.equal(
        await h.vault.get(scope, providerApiKeyVaultKey('seibertgpt')),
        'sgpt_test1234567890',
      );
    }
  });

  it('rejects the key again once the provider is unregistered', async () => {
    const providers = [{ id: 'seibertgpt', label: 'SeibertGPT' }];
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }], providers);
    providers.length = 0;

    const { status, body } = await patch(h, [{ key: 'SEIBERTGPT_API_KEY', value: 'sgpt_test1234567890' }]);
    assert.equal(status, 400);
    assert.equal(body.code, 'settings.no_valid_changes');
  });
});

describe('admin settings route — one field per keyed provider (#1331)', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  const allKeys = (body: Awaited<ReturnType<typeof getSettings>>): string[] =>
    body.categories.flatMap((c) => c.settings.map((s) => s.key));

  it('lists the built-in Mistral provider once, not twice', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }], [
      { id: 'anthropic', label: 'Anthropic' },
      { id: 'openai', label: 'OpenAI' },
      { id: 'mistral', label: 'Mistral' },
    ]);
    const keys = allKeys(await getSettings(h));
    assert.equal(keys.filter((k) => k === 'MISTRAL_API_KEY').length, 1);
    assert.equal(new Set(keys).size, keys.length, `duplicate keys: ${keys.join(', ')}`);
  });

  it('offers no key field for a provider that signs in without a key', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }], [
      {
        id: 'claude-cli',
        label: 'Claude (subscription CLI)',
        policy: { requiresApiKey: false },
        wireFormat: 'claude-cli',
      },
      {
        id: 'openai-chatgpt',
        label: 'ChatGPT',
        policy: { requiresApiKey: false },
        oauth: { flow: 'device' },
      },
      { id: 'minimax', label: 'MiniMax', policy: { requiresApiKey: true } },
      // Keyless but no other sign-in: a stored key is still sent if present.
      { id: 'ollama', label: 'Ollama', policy: { requiresApiKey: false } },
    ]);
    const keys = allKeys(await getSettings(h));
    assert.ok(!keys.includes('CLAUDE_CLI_API_KEY'));
    assert.ok(!keys.includes('OPENAI_CHATGPT_API_KEY'));
    assert.ok(keys.includes('MINIMAX_API_KEY'));
    assert.ok(keys.includes('OLLAMA_API_KEY'));

    const { status, body } = await patch(h, [{ key: 'CLAUDE_CLI_API_KEY', value: 'x'.repeat(40) }]);
    assert.equal(status, 400);
    assert.equal(body.code, 'settings.no_valid_changes');
  });

  it('keeps one field when two provider ids normalise to the same key', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }], [
      { id: 'foo-bar', label: 'Foo Bar' },
      { id: 'foo_bar', label: 'Foo_Bar' },
    ]);
    const keys = allKeys(await getSettings(h));
    assert.equal(keys.filter((k) => k === 'FOO_BAR_API_KEY').length, 1);
  });
});

describe('admin settings route — key format checks (#1330/#1331)', () => {
  it('accepts a short gateway token for a plugin provider', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }], [
      { id: 'litellm', label: 'LiteLLM' },
    ]);
    const { status } = await patch(h, [{ key: 'LITELLM_API_KEY', value: 'sk-1234' }]);
    assert.equal(status, 200);
  });

  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  const cases: Array<{ key: string; value: string; code: string }> = [
    { key: 'MISTRAL_API_KEY', value: '!!!', code: 'settings.api_key_format' },
    { key: 'MISTRAL_API_KEY', value: 'aB3xY7qP9 random32charMistralKey', code: 'settings.api_key_format' },
    { key: 'MISTRAL_API_KEY', value: 'aB3xY7qP9rand', code: 'settings.api_key_format' },
    { key: 'MINIMAX_API_KEY', value: 's', code: 'settings.api_key_format' },
    { key: 'OPENAI_API_KEY', value: ['sk', 'ant', 'falsch'].join('-'), code: 'settings.openai_key_format' },
    { key: 'ANTHROPIC_API_KEY', value: 'sk-test', code: 'settings.anthropic_key_format' },
  ];
  for (const c of cases) {
    it(`rejects ${c.key}=${JSON.stringify(c.value)} with ${c.code}`, async () => {
      h = await makeHarness([{ id: ORCH }, { id: VERIFIER }, { id: EXTRAS }], [
        { id: 'minimax', label: 'MiniMax' },
      ]);
      const { status, body } = await patch(h, [{ key: c.key, value: c.value }]);
      assert.equal(status, 400);
      assert.equal(body.code, 'settings.invalid_values');
      const err = body.errors?.find((e) => e.key === c.key);
      assert.equal(err?.code, c.code);
      // The English reason stays alongside the code for logs and old UIs.
      assert.ok((err?.message.length ?? 0) > 0);
      assert.deepEqual(h.reactivated, []);
      // Nothing was stored.
      assert.deepEqual(await h.vault.listKeys(ORCH), []);
    });
  }
});
