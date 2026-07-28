import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  McpRegistrySecretService,
  backfillMcpRegistryTokens,
  type McpRegistryTokenBackfillStore,
} from '../src/services/mcpRegistrySecretService.js';

/** In-memory Vault double keyed by `${namespace}${key}`. */
function fakeVault() {
  const store = new Map<string, string>();
  const k = (ns: string, key: string) => `${ns}${key}`;
  return {
    store,
    get: async (ns: string, key: string) => store.get(k(ns, key)),
    set: async (ns: string, key: string, value: string) => {
      store.set(k(ns, key), value);
    },
    deleteKey: async (ns: string, key: string) => {
      store.delete(k(ns, key));
    },
  };
}

const NS = '@omadia/mcp-registry';

describe('McpRegistrySecretService', () => {
  it('stores the token in the registry vault namespace keyed by registry id', async () => {
    const vault = fakeVault();
    const svc = new McpRegistrySecretService({ vault });
    await svc.setToken('reg-1', 'sk-secret');
    assert.equal(vault.store.get(`${NS}reg-1`), 'sk-secret');
    assert.equal(await svc.getToken('reg-1'), 'sk-secret');
  });

  it('returns undefined when no token is stored', async () => {
    const svc = new McpRegistrySecretService({ vault: fakeVault() });
    assert.equal(await svc.getToken('missing'), undefined);
  });

  it('deletes the token', async () => {
    const vault = fakeVault();
    const svc = new McpRegistrySecretService({ vault });
    await svc.setToken('reg-1', 'sk-secret');
    await svc.deleteToken('reg-1');
    assert.equal(await svc.getToken('reg-1'), undefined);
    assert.equal(vault.store.size, 0);
  });
});

/** Store double recording legacy-token reads and the columns it cleared. */
function fakeBackfillStore(
  initial: { id: string; token: string }[],
): McpRegistryTokenBackfillStore & { cleared: string[]; remaining: () => { id: string; token: string }[] } {
  let rows = [...initial];
  const cleared: string[] = [];
  return {
    cleared,
    remaining: () => rows,
    listLegacyMcpRegistryTokens: async () => rows,
    clearLegacyMcpRegistryToken: async (id: string) => {
      cleared.push(id);
      rows = rows.filter((r) => r.id !== id);
    },
  };
}

describe('backfillMcpRegistryTokens', () => {
  it('moves every legacy plaintext token into the vault and clears the column', async () => {
    const vault = fakeVault();
    const secrets = new McpRegistrySecretService({ vault });
    const store = fakeBackfillStore([
      { id: 'reg-1', token: 'tok-1' },
      { id: 'reg-2', token: 'tok-2' },
    ]);

    const moved = await backfillMcpRegistryTokens({ store, secrets });

    assert.equal(moved, 2);
    assert.equal(await secrets.getToken('reg-1'), 'tok-1');
    assert.equal(await secrets.getToken('reg-2'), 'tok-2');
    assert.deepEqual(store.cleared.sort(), ['reg-1', 'reg-2']);
    assert.equal(store.remaining().length, 0);
  });

  it('is a no-op when there is nothing to migrate (idempotent second pass)', async () => {
    const vault = fakeVault();
    const secrets = new McpRegistrySecretService({ vault });
    const store = fakeBackfillStore([{ id: 'reg-1', token: 'tok-1' }]);

    assert.equal(await backfillMcpRegistryTokens({ store, secrets }), 1);
    // second pass: column already cleared, nothing left to do
    assert.equal(await backfillMcpRegistryTokens({ store, secrets }), 0);
    assert.equal(store.cleared.length, 1);
  });
});
