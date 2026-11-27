/**
 * #1076 — the generic runtime config-write paths can write the orchestrator's
 * `llm_provider` too (it is not a secret field, so it lands in the registry
 * config). They go through the same `reactivateAfterProviderWrite` as the
 * providers admin route, so EVERY writer of that key rebuilds
 * `@omadia/orchestrator-extras` before the orchestrator.
 */
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import express from 'express';
import type { Express } from 'express';

import { createRuntimeRouter } from '../src/routes/runtime.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';

const ORCH = '@omadia/orchestrator';
const EXTRAS = '@omadia/orchestrator-extras';
const VERIFIER = '@omadia/verifier';
/** #1891 — a provider plugin: its manifest carries an `llm_provider` block. */
const ANTHROPIC_PLUGIN = '@omadia/plugin-llm-anthropic';

/** `runtime.dependent_rebuild_failed` — the write landed, a dependent is down. */
interface DependentFailureBody {
  code: string;
  message: string;
  dependentId?: string;
  primaryApplied?: boolean;
}

interface Harness {
  baseUrl: string;
  registry: InMemoryInstalledRegistry;
  reactivated: string[];
  close(): Promise<void>;
}

async function makeHarness(
  installed: Array<{ id: string; config?: Record<string, unknown> }>,
  opts: { erroredOn?: string; erroredTimes?: number } = {},
): Promise<Harness> {
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
  // The secrets route splits vault vs config by the manifest's field types.
  // Declaring `llm_provider` as a plain string routes it into the config.
  const orchEntry: PluginCatalogEntry = {
    plugin: { id: ORCH, name: 'Orchestrator', version: '0.1.0' } as never,
    manifest: {
      setup: {
        fields: [
          { key: 'llm_provider', type: 'string' },
          { key: 'anthropic_api_key', type: 'secret' },
        ],
      },
    },
    source_path: '<test>',
    source_kind: 'manifest-v1',
    origin: 'installed',
  };
  const providerEntry: PluginCatalogEntry = {
    plugin: { id: ANTHROPIC_PLUGIN, name: 'Anthropic', version: '0.1.0' } as never,
    manifest: {
      llm_provider: {
        id: 'anthropic',
        label: 'Anthropic',
        wire_format: 'anthropic',
        default_base_url: 'https://api.anthropic.com',
        models: [
          {
            id: 'anthropic:claude-haiku-5-5',
            model_id: 'claude-haiku-5-5',
            label: 'Haiku',
            class: 'fast',
            max_tokens: 1000,
            context_window: 2000,
            vision: false,
          },
        ],
      },
      setup: { fields: [{ key: 'anthropic_base_url', type: 'string' }] },
    },
    source_path: '<test>',
    source_kind: 'manifest-v1',
    origin: 'installed',
  };
  const catalog = {
    get: (id: string): PluginCatalogEntry | undefined =>
      id === ORCH ? orchEntry : id === ANTHROPIC_PLUGIN ? providerEntry : undefined,
  } as unknown as PluginCatalog;

  const reactivated: string[] = [];
  let erroredLeft = opts.erroredTimes ?? Number.POSITIVE_INFINITY;
  const stubReg = {
    names: () => [],
    counts: () => ({ before_turn: 0, after_tool_call: 0, after_turn: 0 }),
  };
  const app: Express = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin/runtime',
    createRuntimeRouter({
      installedRegistry: registry,
      // #1453 — required dependency; this suite does not exercise the verify
      // endpoint, so it answers "this plugin declares no probe".
      verifyConnection: async () => undefined,
      serviceRegistry: stubReg as never,
      turnHookRegistry: stubReg as never,
      backgroundJobRegistry: stubReg as never,
      chatAgentWrapRegistry: { labels: () => [], count: () => 0 } as never,
      promptContributionRegistry: { labels: () => [], count: () => 0 } as never,
      vault: new InMemorySecretVault(),
      catalog,
      reactivate: async (id: string): Promise<void> => {
        reactivated.push(id);
        // Mirror production `installService.reactivate` on a failed
        // activation: record it, flip to `errored`, return normally. A later
        // successful rebuild lifts `errored` again (`clearActivationError`).
        if (opts.erroredOn === id && erroredLeft > 0) {
          erroredLeft -= 1;
          await registry.markActivationBlocked(id, `${id} activate() exploded`);
        } else {
          await registry.clearActivationError(id);
        }
      },
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/api/v1/admin/runtime`,
    registry,
    reactivated,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function patchWithBody(
  url: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

async function patch(url: string, body: unknown): Promise<number> {
  return (await patchWithBody(url, body)).status;
}

describe('runtime config writes rebuild provider dependents (#1076)', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('PATCH /installed/:id/config with a new llm_provider rebuilds extras, then the orchestrator', async () => {
    h = await makeHarness([{ id: ORCH }, { id: EXTRAS }]);
    const status = await patch(`${h.baseUrl}/installed/${encodeURIComponent(ORCH)}/config`, {
      llm_provider: 'claude-cli',
    });
    assert.equal(status, 200);
    assert.equal(h.registry.get(ORCH)?.config['llm_provider'], 'claude-cli');
    assert.deepEqual(h.reactivated, [EXTRAS, ORCH]);
  });

  it('PATCH /installed/:id/config reports a dependent left errored instead of a 200', async () => {
    h = await makeHarness([{ id: ORCH }, { id: EXTRAS }], { erroredOn: EXTRAS });
    const res = await patchWithBody(
      `${h.baseUrl}/installed/${encodeURIComponent(ORCH)}/config`,
      { llm_provider: 'claude-cli' },
    );
    assert.equal(res.status, 500);
    const body = JSON.parse(res.body) as DependentFailureBody;
    assert.equal(body.code, 'runtime.dependent_rebuild_failed');
    assert.match(body.message, /orchestrator-extras failed to rebuild/);
    assert.equal(body.dependentId, EXTRAS);
    assert.equal(body.primaryApplied, true);
    // The orchestrator was still rebuilt on the persisted config.
    assert.deepEqual(h.reactivated, [EXTRAS, ORCH]);
    assert.equal(h.registry.get(ORCH)?.config['llm_provider'], 'claude-cli');
  });

  // "Save again" after a failed extras rebuild carries the SAME provider; it
  // must still retry extras instead of answering 200 over an errored dependent.
  it('PATCH /installed/:id/config re-saving the same provider retries an errored dependent', async () => {
    h = await makeHarness([{ id: ORCH }, { id: EXTRAS }], { erroredOn: EXTRAS, erroredTimes: 1 });
    const url = `${h.baseUrl}/installed/${encodeURIComponent(ORCH)}/config`;
    assert.equal(await patch(url, { llm_provider: 'claude-cli' }), 500);
    h.reactivated.length = 0;
    assert.equal(await patch(url, { llm_provider: 'claude-cli' }), 200);
    assert.deepEqual(h.reactivated, [EXTRAS, ORCH]);
    assert.equal(h.registry.get(EXTRAS)?.status, 'active');
  });

  it('PATCH /installed/:id/secrets re-saving the same provider still reports a dependent that stays errored', async () => {
    h = await makeHarness(
      [{ id: ORCH, config: { llm_provider: 'anthropic' } }, { id: EXTRAS }],
      { erroredOn: EXTRAS },
    );
    const url = `${h.baseUrl}/installed/${encodeURIComponent(ORCH)}/secrets`;
    assert.equal(await patch(url, { set: { llm_provider: 'openai' } }), 500);
    h.reactivated.length = 0;
    const res = await patchWithBody(url, { set: { llm_provider: 'openai' } });
    assert.equal(res.status, 500);
    const body = JSON.parse(res.body) as DependentFailureBody;
    assert.equal(body.code, 'runtime.dependent_rebuild_failed');
    assert.match(body.message, /unchanged provider/);
    assert.equal(body.primaryApplied, true);
    assert.deepEqual(h.reactivated, [EXTRAS, ORCH]);
  });

  it('PATCH /installed/:id/secrets reports a dependent left errored instead of a 200', async () => {
    h = await makeHarness(
      [{ id: ORCH, config: { llm_provider: 'anthropic' } }, { id: EXTRAS }],
      { erroredOn: EXTRAS },
    );
    const res = await patchWithBody(
      `${h.baseUrl}/installed/${encodeURIComponent(ORCH)}/secrets`,
      { set: { llm_provider: 'openai' } },
    );
    assert.equal(res.status, 500);
    const body = JSON.parse(res.body) as DependentFailureBody;
    assert.equal(body.code, 'runtime.dependent_rebuild_failed');
    assert.match(body.message, /orchestrator-extras failed to rebuild/);
    assert.equal(body.dependentId, EXTRAS);
    assert.equal(body.primaryApplied, true);
    // The config write itself landed.
    assert.equal(h.registry.get(ORCH)?.config['llm_provider'], 'openai');
    assert.deepEqual(h.reactivated, [EXTRAS, ORCH]);
  });

  it('PATCH /installed/:id/config without a provider change rebuilds only that plugin', async () => {
    h = await makeHarness([{ id: ORCH }, { id: EXTRAS }]);
    const status = await patch(`${h.baseUrl}/installed/${encodeURIComponent(ORCH)}/config`, {
      _privacy_mode: 'bypass',
    });
    assert.equal(status, 200);
    assert.deepEqual(h.reactivated, [ORCH]);
  });

  it('PATCH /installed/:id/secrets writing llm_provider into the config rebuilds extras first', async () => {
    h = await makeHarness([{ id: ORCH, config: { llm_provider: 'anthropic' } }, { id: EXTRAS }]);
    const status = await patch(`${h.baseUrl}/installed/${encodeURIComponent(ORCH)}/secrets`, {
      set: { llm_provider: 'openai' },
    });
    assert.equal(status, 200);
    assert.equal(h.registry.get(ORCH)?.config['llm_provider'], 'openai');
    assert.deepEqual(h.reactivated, [EXTRAS, ORCH]);
  });

  it('PATCH /installed/:id/secrets touching only a non-provider vault key rebuilds only that plugin', async () => {
    h = await makeHarness([{ id: ORCH, config: { llm_provider: 'anthropic' } }, { id: EXTRAS }]);
    const status = await patch(`${h.baseUrl}/installed/${encodeURIComponent(ORCH)}/secrets`, {
      set: { some_token: 'x' },
    });
    assert.equal(status, 200);
    assert.deepEqual(h.reactivated, [ORCH]);
  });

  // #2240 / ADR-0215 — a provider key in the kernel scope is every LLM
  // plugin's key: extras is rebuilt first, then the orchestrator.
  it('PATCH /installed/:id/secrets with the Anthropic key rebuilds extras, then the orchestrator', async () => {
    h = await makeHarness([{ id: ORCH, config: { llm_provider: 'anthropic' } }, { id: EXTRAS }]);
    const status = await patch(`${h.baseUrl}/installed/${encodeURIComponent(ORCH)}/secrets`, {
      set: { anthropic_api_key: 'sk-ant-test' },
    });
    assert.equal(status, 200);
    assert.deepEqual(h.reactivated, [EXTRAS, ORCH]);
  });
});

describe('#1891 — a provider plugin config write rebuilds the LLM plugins', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('PATCH config of the provider plugin rebuilds it, then the LLM plugins on its provider, the orchestrator last', async () => {
    h = await makeHarness([{ id: ANTHROPIC_PLUGIN }, { id: ORCH }, { id: EXTRAS }, { id: VERIFIER }]);
    const status = await patch(`${h.baseUrl}/installed/${encodeURIComponent(ANTHROPIC_PLUGIN)}/config`, {
      anthropic_base_url: 'https://api.anthropic.com',
    });
    assert.equal(status, 200);
    assert.equal(h.reactivated[0], ANTHROPIC_PLUGIN);
    assert.deepEqual([...h.reactivated].sort(), [ANTHROPIC_PLUGIN, EXTRAS, ORCH, VERIFIER].sort());
    assert.equal(h.reactivated.at(-1), ORCH, 'the capturing orchestrator is rebuilt last');
  });

  it('skips a verifier that runs on another provider; the agent runtime is always rebuilt', async () => {
    h = await makeHarness([
      { id: ANTHROPIC_PLUGIN },
      { id: ORCH },
      { id: VERIFIER, config: { llm_provider: 'openai' } },
    ]);
    const status = await patch(`${h.baseUrl}/installed/${encodeURIComponent(ANTHROPIC_PLUGIN)}/config`, {
      anthropic_base_url: 'https://api.anthropic.com',
    });
    assert.equal(status, 200);
    assert.deepEqual(h.reactivated, [ANTHROPIC_PLUGIN, ORCH]);
  });

  it('reports an LLM plugin that does not come back up', async () => {
    h = await makeHarness([{ id: ANTHROPIC_PLUGIN }, { id: ORCH }, { id: EXTRAS }], { erroredOn: EXTRAS });
    const res = await patchWithBody(
      `${h.baseUrl}/installed/${encodeURIComponent(ANTHROPIC_PLUGIN)}/config`,
      { anthropic_base_url: 'https://api.anthropic.com' },
    );
    assert.equal(res.status, 500);
    const body = JSON.parse(res.body) as DependentFailureBody;
    assert.equal(body.code, 'runtime.dependent_rebuild_failed');
    assert.equal(body.dependentId, EXTRAS);
    assert.equal(body.primaryApplied, true);
  });

  it('a provider plugin that stays down is reported and nothing is rebuilt onto it', async () => {
    h = await makeHarness([{ id: ANTHROPIC_PLUGIN }, { id: ORCH }, { id: EXTRAS }], { erroredOn: ANTHROPIC_PLUGIN });
    const res = await patchWithBody(
      `${h.baseUrl}/installed/${encodeURIComponent(ANTHROPIC_PLUGIN)}/config`,
      { anthropic_base_url: 'https://broken.example' },
    );
    assert.equal(res.status, 500);
    const body = JSON.parse(res.body) as DependentFailureBody;
    assert.equal(body.dependentId, ANTHROPIC_PLUGIN);
    assert.equal(body.primaryApplied, false);
    assert.deepEqual(h.reactivated, [ANTHROPIC_PLUGIN]);
  });

  it('a non-provider plugin write rebuilds no LLM plugin', async () => {
    h = await makeHarness([{ id: '@omadia/plugin-office' }, { id: ORCH }, { id: EXTRAS }]);
    const status = await patch(`${h.baseUrl}/installed/${encodeURIComponent('@omadia/plugin-office')}/config`, {
      some_key: 'x',
    });
    assert.equal(status, 200);
    assert.deepEqual(h.reactivated, ['@omadia/plugin-office']);
  });
});

describe('#2240 — provider keys are refused outside the kernel scope', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('PATCH secrets of extras with a provider API key answers 400 and writes nothing', async () => {
    h = await makeHarness([{ id: ORCH }, { id: EXTRAS }]);
    const res = await patchWithBody(`${h.baseUrl}/installed/${encodeURIComponent(EXTRAS)}/secrets`, {
      set: { 'provider:anthropic/api_key': 'sk-ant-dedicated' },
    });
    assert.equal(res.status, 400);
    assert.equal((JSON.parse(res.body) as { code: string }).code, 'runtime.provider_key_in_kernel_scope');
    assert.deepEqual(h.reactivated, []);
  });

  it('PATCH config of the verifier with the legacy key name answers 400', async () => {
    h = await makeHarness([{ id: ORCH }, { id: VERIFIER }]);
    const res = await patchWithBody(`${h.baseUrl}/installed/${encodeURIComponent(VERIFIER)}/config`, {
      anthropic_api_key: 'sk-ant-dedicated',
    });
    assert.equal(res.status, 400);
    assert.equal(h.registry.get(VERIFIER)?.config['anthropic_api_key'], undefined);
  });

  it('a key written to the kernel scope rebuilds every LLM plugin, the orchestrator last', async () => {
    h = await makeHarness([{ id: ORCH }, { id: EXTRAS }, { id: VERIFIER }]);
    const status = await patch(`${h.baseUrl}/installed/${encodeURIComponent(ORCH)}/secrets`, {
      set: { anthropic_api_key: 'sk-ant-kernel' },
    });
    assert.equal(status, 200);
    assert.deepEqual([...h.reactivated].sort(), [EXTRAS, ORCH, VERIFIER].sort());
    assert.equal(h.reactivated.at(-1), ORCH);
  });
});
