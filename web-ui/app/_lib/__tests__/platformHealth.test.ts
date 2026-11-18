import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  databaseCheckOf,
  devMasterKeysOf,
  fetchMiddlewareHealth,
  platformNotice,
  type MiddlewareHealth,
} from '../platformHealth';
import type { VaultStatusResponse } from '../api';

/**
 * #1385 / #1384 / #1332 — the middleware's own `/health`, read server-side.
 * It is the one unauthenticated source that still answers during a Postgres
 * outage, so these tests pin that a 503 is parsed, that an unreachable
 * middleware is a result rather than a throw, and which banner each state
 * raises.
 */

function healthy(database: 'ok' | 'unreachable' = 'ok'): MiddlewareHealth {
  return { reachable: true, body: { checks: { database } } };
}

type KeySource = VaultStatusResponse['vault']['master_key_source'];

function vault(vaultKey: KeySource, keychainKey?: KeySource): VaultStatusResponse {
  return {
    vault: {
      path: '/data/vault.enc',
      data_dir: '/data',
      exists: true,
      size_bytes: 1,
      last_modified: null,
      agent_count: 0,
      master_key_source: vaultKey,
      ...(keychainKey === undefined ? {} : { keychain_key_source: keychainKey }),
      production_ready: vaultKey === 'env' && keychainKey === 'env',
    },
    backup: {
      enabled: false,
      bucket: '',
      prefix: '',
      retention: 0,
      interval_hours: 0,
      last_run_at: null,
      last_success_at: null,
      next_run_at: null,
      last_error: null,
      objects_kept: null,
    },
  };
}

describe('fetchMiddlewareHealth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses the snapshot from a 503 — a dead pool still sends the full body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 503,
      json: () =>
        Promise.resolve({
          status: 'error',
          checks: { database: 'unreachable' },
        }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const health = await fetchMiddlewareHealth();
    expect(health.reachable).toBe(true);
    expect(databaseCheckOf(health)).toBe('unreachable');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/health$/),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('reports unreachable instead of throwing on a transport error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(fetchMiddlewareHealth()).resolves.toEqual({ reachable: false });
  });

  it('reports unreachable on a body that is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 502, json: () => Promise.reject(new SyntaxError('x')) }),
    );
    await expect(fetchMiddlewareHealth()).resolves.toEqual({ reachable: false });
  });
});

describe('databaseCheckOf', () => {
  it('falls back to kg.pool on a middleware without the checks block', () => {
    const dead: MiddlewareHealth = {
      reachable: true,
      body: { kg: { backend: 'neon', embeddings: true, semanticRecall: true, pool: 'dead', warnings: [] } },
    };
    expect(databaseCheckOf(dead)).toBe('unreachable');
  });

  it('is null when the middleware did not answer', () => {
    expect(databaseCheckOf({ reachable: false })).toBeNull();
  });
});

describe('devMasterKeysOf (from the authenticated vault status)', () => {
  it('lists each key that does not come from its env var', () => {
    expect(devMasterKeysOf(vault('dev-file-existed', 'dev-file-created'))).toEqual([
      'vault',
      'keychain',
    ]);
    expect(devMasterKeysOf(vault('env', 'dev-file-existed'))).toEqual(['keychain']);
    expect(devMasterKeysOf(vault('env', 'env'))).toEqual([]);
  });

  it('does not guess the keychain key on an older middleware', () => {
    expect(devMasterKeysOf(vault('env'))).toEqual([]);
  });

  it('is empty when the vault status could not be read', () => {
    expect(devMasterKeysOf(null)).toEqual([]);
  });
});

describe('platformNotice', () => {
  it('names the database when /health says it is unreachable', () => {
    expect(platformNotice({ health: healthy('unreachable') })).toEqual({
      kind: 'databaseUnreachable',
    });
  });

  it('names the database from a 503 auth.unavailable even without /health', () => {
    expect(platformNotice({ health: { reachable: false }, databaseUnavailable: true })).toEqual({
      kind: 'databaseUnreachable',
    });
  });

  it('reports an unreachable middleware', () => {
    expect(platformNotice({ health: { reachable: false } })).toEqual({
      kind: 'middlewareUnreachable',
    });
  });

  it('warns about dev master keys, naming which (#1332, #1387)', () => {
    expect(platformNotice({ health: healthy(), vault: vault('dev-file-existed', 'env') })).toEqual({
      kind: 'devMasterKey',
      which: 'vault',
    });
    expect(platformNotice({ health: healthy(), vault: vault('env', 'dev-file-existed') })).toEqual({
      kind: 'devMasterKey',
      which: 'keychain',
    });
    expect(
      platformNotice({ health: healthy(), vault: vault('dev-file-created', 'dev-file-created') }),
    ).toEqual({ kind: 'devMasterKey', which: 'both' });
  });

  it('lets the outage outrank the dev-key warning', () => {
    expect(
      platformNotice({ health: healthy('unreachable'), vault: vault('dev-file-existed', 'env') }),
    ).toEqual({ kind: 'databaseUnreachable' });
  });

  it('is silent on a healthy production stack', () => {
    expect(platformNotice({ health: healthy(), vault: vault('env', 'env') })).toBeNull();
  });
});
