import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { AgentGraphStore, McpServerConfig, McpServerRow } from '@omadia/orchestrator';

import { McpConfigService } from '../src/services/mcpConfigService.js';
import {
  isHeaderRefusal,
  planHeaders,
  reconcileConfigSchema,
  secretHeaderFieldKey,
  validateHeaderInput,
  viewHeaders,
} from '../src/services/mcpStaticHeaders.js';

/** #1912 / ADR-0210 — static MCP headers with Vault-backed secret values. */
describe('validateHeaderInput (#1912)', () => {
  const code = (raw: unknown): string | undefined => {
    const r = validateHeaderInput(raw);
    return isHeaderRefusal(r) ? r.code : undefined;
  };

  it('accepts plain and secret headers, Authorization included', () => {
    assert.equal(
      code([
        { name: 'x-api-key', value: 'k', secret: true },
        { name: 'Authorization', value: 'Bearer t', secret: true },
        { name: 'X-Tenant', value: '{tenant}', secret: false },
      ]),
      undefined,
    );
  });

  it('refuses bad names, reserved and duplicate names, CR/LF, missing plain values', () => {
    assert.equal(code('nope'), 'headers_invalid');
    assert.equal(code([{ name: 'bad name', value: 'x', secret: false }]), 'header_name_invalid');
    assert.equal(code([{ name: 'Content-Type', value: 'x', secret: false }]), 'header_name_reserved');
    assert.equal(code([{ name: 'Mcp-Session-Id', value: 'x', secret: false }]), 'header_name_reserved');
    assert.equal(
      code([
        { name: 'X-A', value: '1', secret: false },
        { name: 'x-a', value: '2', secret: false },
      ]),
      'header_name_duplicate',
    );
    assert.equal(code([{ name: 'X-A', value: 'a\r\nInjected: 1', secret: false }]), 'header_value_invalid');
    assert.equal(code([{ name: 'X-A', secret: false }]), 'header_value_required');
  });

  it('a secret header without a value keeps the stored secret', () => {
    const input = validateHeaderInput([{ name: 'x-api-key', secret: true }]);
    assert.ok(!isHeaderRefusal(input));
    const plan = planHeaders(input);
    assert.deepEqual(plan.keptSecretKeys, ['header_x_api_key']);
    assert.equal(plan.secretWrites.size, 0);
  });
});

describe('planHeaders / reconcileConfigSchema / viewHeaders (#1912)', () => {
  it('stores a secret header as its placeholder and the value only in the write set', () => {
    const input = validateHeaderInput([
      { name: 'x-api-key', value: 'sk-secret', secret: true },
      { name: 'X-Plain', value: 'visible', secret: false },
    ]);
    assert.ok(!isHeaderRefusal(input));
    const plan = planHeaders(input);
    assert.deepEqual(plan.headers, { 'x-api-key': '{header_x_api_key}', 'X-Plain': 'visible' });
    assert.equal(plan.secretWrites.get('header_x_api_key'), 'sk-secret');
    assert.doesNotMatch(JSON.stringify(plan.headers), /sk-secret/);
  });

  it('derives fields from endpoint and headers, forces header secrets secret, drops vanished fields', () => {
    const { schema, removedSecretKeys } = reconcileConfigSchema(
      'https://x.example/mcp?region={region}',
      { 'x-api-key': '{header_x_api_key}' },
      [
        { key: 'region', label: 'Region', type: 'string', required: true, secret: false },
        { key: 'api_key', label: 'old', type: 'string', required: true, secret: true },
      ],
    );
    assert.deepEqual(
      schema.map((f) => [f.key, f.secret, f.label]),
      [
        ['region', false, 'Region'],
        ['header_x_api_key', true, 'Header x-api-key'],
      ],
    );
    assert.deepEqual(removedSecretKeys, ['api_key']);
  });

  it('never shows a secret header value', () => {
    const view = viewHeaders(
      { 'x-api-key': '{header_x_api_key}', 'X-Plain': 'visible' },
      { header_x_api_key: true },
    );
    assert.deepEqual(view, [
      { name: 'x-api-key', secret: true, value: null, secretSet: true },
      { name: 'X-Plain', secret: false, value: 'visible' },
    ]);
  });

  it('secretHeaderFieldKey is a placeholder-safe key', () => {
    assert.equal(secretHeaderFieldKey('X-API.Key'), 'header_x_api_key');
  });
});

describe('McpConfigService endpoint and header secrets (#1912)', () => {
  const row = (overrides: Partial<McpServerRow>): McpServerRow =>
    ({
      id: 'srv',
      name: 'srv',
      transport: 'http',
      endpoint: 'https://x.example/mcp?key={api_key}&r={region}',
      headers: { 'x-api-key': '{header_x_api_key}', 'X-Mix': '{region}:{header_x_api_key}' },
      secretRef: null,
      status: 'enabled',
      lastDiscoveredAt: null,
      discoveredTools: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      source: 'manual',
      registryId: null,
      license: null,
      author: null,
      sourceUrl: null,
      privacyBypass: false,
      kgIngest: false,
      config: { region: 'eu' },
      configSchema: [
        { key: 'api_key', label: 'api_key', type: 'string', required: true, secret: true },
        { key: 'region', label: 'region', type: 'string', required: true, secret: false },
        { key: 'header_x_api_key', label: 'h', type: 'string', required: true, secret: true },
      ],
      delegation: 'per_user',
      ...overrides,
    }) as McpServerRow;

  function service(server: McpServerRow): McpConfigService {
    const store = new Map([
      ['srv:api_key', 'url-secret'],
      ['srv:header_x_api_key', 'hdr-secret'],
    ]);
    return new McpConfigService({
      graph: { listMcpServers: async () => [server] } as unknown as AgentGraphStore,
      vault: {
        get: async (_ns, key) => store.get(key),
        set: async (_ns, key, value) => {
          store.set(key, value);
        },
      },
    });
  }
  const cfg = { id: 'srv' } as McpServerConfig;

  it('fills a secret endpoint placeholder at connect time', async () => {
    assert.equal(
      await service(row({})).getConfigEndpoint(cfg),
      'https://x.example/mcp?key=url-secret&r=eu',
    );
  });

  it('returns undefined when the endpoint holds no secret', async () => {
    assert.equal(
      await service(row({ endpoint: 'https://x.example/mcp?r={region}' })).getConfigEndpoint(cfg),
      undefined,
    );
  });

  it('fills secret headers, plain placeholders in the same header included', async () => {
    assert.deepEqual(await service(row({})).getConfigHeaders(cfg), {
      'x-api-key': 'hdr-secret',
      'X-Mix': 'eu:hdr-secret',
    });
  });
});
