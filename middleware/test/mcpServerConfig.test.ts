import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  substituteMcpConfig,
  deriveMcpConfigSchema,
} from '../src/agents/subAgentToolHydration.js';

describe('MCP server config (epic #459)', () => {
  it('substitutes {key} placeholders from non-secret config, leaves unknown ones', () => {
    const ep =
      'https://agent365.svc.cloud.microsoft/agents/tenants/{tenant_id}/servers/mcp_M365Copilot';
    assert.equal(
      substituteMcpConfig(ep, { tenant_id: 'abc-123' }),
      'https://agent365.svc.cloud.microsoft/agents/tenants/abc-123/servers/mcp_M365Copilot',
    );
    // Unknown / secret keys stay as-is (resolved later or reported unconfigured).
    assert.equal(substituteMcpConfig('Bearer {apiKey}', { tenant_id: 'x' }), 'Bearer {apiKey}');
    assert.equal(substituteMcpConfig('no placeholders', {}), 'no placeholders');
  });

  it('derives a required non-secret field per placeholder in endpoint + headers', () => {
    const schema = deriveMcpConfigSchema(
      'https://x/tenants/{tenant_id}/mcp',
      { Authorization: 'Bearer {apiKey}' },
      [],
    );
    const keys = schema.map((f) => f.key).sort();
    assert.deepEqual(keys, ['apiKey', 'tenant_id']);
    for (const f of schema) {
      assert.equal(f.required, true);
      assert.equal(f.secret, false); // default; operator flips per field
      assert.equal(f.type, 'string');
    }
  });

  it('preserves an existing field (its secret flag/label) when re-deriving', () => {
    const existing = [
      { key: 'apiKey', label: 'API Key', type: 'string' as const, required: true, secret: true },
    ];
    const schema = deriveMcpConfigSchema('https://x/mcp', { Authorization: '{apiKey}' }, existing);
    assert.equal(schema.length, 1);
    assert.equal(schema[0]!.secret, true); // kept, not reset to false
    assert.equal(schema[0]!.label, 'API Key');
  });
});
