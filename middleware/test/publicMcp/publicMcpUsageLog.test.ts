import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createAuditLog } from '../../packages/harness-api-key-auth/src/auditLog.js';
import { InMemorySecretVault } from '../../src/secrets/vault.js';
import {
  API_KEY_VAULT_NAMESPACE,
  createPublicMcpUsageLog,
} from '../../src/mcp/wirePublicMcp.js';

/**
 * #1329 — MCP requests land in the same per-key usage log the admin page
 * reads, and the endpoint's writer can touch that one vault entry only.
 */
describe('#1329 — public MCP usage log', () => {
  it('writes into the channel-api usage log, interleaving safely with the chat writer', async () => {
    const vault = new InMemorySecretVault();
    const mcpLog = createPublicMcpUsageLog(vault);
    const chatLog = createAuditLog({
      get: (k) => vault.get(API_KEY_VAULT_NAMESPACE, k),
      keys: () => vault.listKeys(API_KEY_VAULT_NAMESPACE),
      set: (k, v) => vault.set(API_KEY_VAULT_NAMESPACE, k, v),
    });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 ? mcpLog : chatLog).record({
          keyId: `k${i}`,
          route: i % 2 ? '/api/v1/mcp' : '/api/public/v1/chat',
          method: 'POST',
          at: i,
          status: 'ok',
        }),
      ),
    );
    assert.equal((await chatLog.list()).length, 10, 'no append lost between the two writers');
    assert.equal((await chatLog.lastUsed())['k1'], 1);
  });

  it('refuses to write any other key in the API-key namespace', async () => {
    const vault = new InMemorySecretVault();
    const before = await vault.listKeys(API_KEY_VAULT_NAMESPACE);
    const mcpLog = createPublicMcpUsageLog(vault);
    await mcpLog.record({ keyId: 'k', route: '/api/v1/mcp', method: 'POST', at: 1, status: 'ok' });
    const after = await vault.listKeys(API_KEY_VAULT_NAMESPACE);
    assert.deepEqual(after.filter((k) => !before.includes(k)), ['usage-audit-log']);
  });
});
