import type { SecretsAccessor } from '../../packages/plugin-api/src/index.js';

/**
 * In-memory `SecretsAccessor` for issue #438's channel-api tests — mirrors
 * the shape `platform/pluginContext.ts` hands a plugin whose manifest
 * declares `permissions.secrets.runtime_write`, without dragging in the real
 * `FileSecretVault`/encryption machinery.
 */
export function createFakeSecrets(): SecretsAccessor {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key);
    },
    async require(key: string) {
      const v = store.get(key);
      if (v === undefined) throw new Error(`fake secrets: missing key '${key}'`);
      return v;
    },
    async keys() {
      return Array.from(store.keys());
    },
    async set(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}
