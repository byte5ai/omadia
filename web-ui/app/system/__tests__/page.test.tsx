import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enMessages from '../../../messages/en.json';
import { ApiError, type VaultStatusResponse } from '../../_lib/api';
import type { MiddlewareHealth } from '../../_lib/platformHealth';

/**
 * #1385 — `/system` is titled "Platform health" but showed the vault card
 * alone; during a Postgres outage it said "Vault status unreachable" and never
 * mentioned the database. #1387 — the vault card ignored the keychain master
 * key and called the instance "production" with only VAULT_KEY set.
 */

const { mockGetVaultStatus, mockFetchHealth } = vi.hoisted(() => ({
  mockGetVaultStatus: vi.fn(),
  mockFetchHealth: vi.fn(),
}));

vi.mock('../../_lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../_lib/api')>()),
  getVaultStatus: mockGetVaultStatus,
}));

vi.mock('../../_lib/platformHealth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../_lib/platformHealth')>()),
  fetchMiddlewareHealth: mockFetchHealth,
}));

vi.mock('../../_lib/authRedirect', () => ({
  redirectIfUnauthorized: vi.fn(),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: enMessages as Record<string, unknown>,
      namespace,
    }),
  getFormatter: async () => ({ dateTime: (d: Date) => d.toISOString() }),
}));

// Both cards are async server components, which the test renderer cannot
// resolve as children. The page is tested with stand-ins that expose what it
// handed them; the cards themselves are awaited directly below.
vi.mock('../_components/PlatformHealthCard', () => ({
  PlatformHealthCard: ({ health }: { health: MiddlewareHealth }): React.ReactElement => (
    <div data-testid="platform-health-card-stub" data-reachable={String(health.reachable)} />
  ),
}));
vi.mock('../_components/VaultStatusCard', () => ({
  VaultStatusCard: (): React.ReactElement => <div data-testid="vault-card-stub" />,
}));

import SystemPage from '../page';

const { PlatformHealthCard } = await vi.importActual<
  typeof import('../_components/PlatformHealthCard')
>('../_components/PlatformHealthCard');
const { VaultStatusCard } = await vi.importActual<
  typeof import('../_components/VaultStatusCard')
>('../_components/VaultStatusCard');

function vaultStatus(
  over: Partial<VaultStatusResponse['vault']> = {},
): VaultStatusResponse {
  return {
    vault: {
      path: '/data/vault/vault.enc',
      data_dir: '/data/vault',
      exists: true,
      size_bytes: 1024,
      last_modified: '2026-10-01T00:00:00Z',
      agent_count: 2,
      master_key_source: 'env',
      keychain_key_source: 'env',
      production_ready: true,
      ...over,
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

const HEALTHY: MiddlewareHealth = {
  reachable: true,
  body: {
    version: 'sha-1234abcd',
    checks: { database: 'ok' },
    kg: { backend: 'neon', embeddings: true, semanticRecall: true, pool: 'live', warnings: [] },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('/system page (#1385)', () => {
  it('renders the platform health card even when the vault call fails with the outage 503', async () => {
    mockGetVaultStatus.mockRejectedValue(
      new ApiError(
        503,
        'GET /v1/admin/vault-status failed: 503',
        JSON.stringify({ code: 'auth.unavailable', message: 'session check unavailable' }),
      ),
    );
    mockFetchHealth.mockResolvedValue(HEALTHY);
    render(await SystemPage());

    expect(screen.getByTestId('platform-health-card-stub')).toBeTruthy();
    expect(screen.getByTestId('vault-load-error-database').textContent).toMatch(/database/);
  });

  it('renders both cards on a healthy stack', async () => {
    mockGetVaultStatus.mockResolvedValue(vaultStatus());
    mockFetchHealth.mockResolvedValue(HEALTHY);
    render(await SystemPage());

    expect(screen.getByTestId('platform-health-card-stub').dataset['reachable']).toBe('true');
    expect(screen.getByTestId('vault-card-stub')).toBeTruthy();
    expect(screen.queryByTestId('vault-load-error-database')).toBeNull();
  });

  it('does not blame the database for a vault error that is not the outage', async () => {
    mockGetVaultStatus.mockRejectedValue(new TypeError('fetch failed'));
    mockFetchHealth.mockResolvedValue({ reachable: false });
    render(await SystemPage());

    expect(screen.getByTestId('platform-health-card-stub').dataset['reachable']).toBe('false');
    expect(screen.queryByTestId('vault-load-error-database')).toBeNull();
  });
});

describe('<PlatformHealthCard /> (#1385)', () => {
  it('shows the database and the middleware version', async () => {
    render(await PlatformHealthCard({ health: HEALTHY }));
    const card = screen.getByTestId('platform-health-card');
    expect(card.textContent).toMatch(/Database \(Postgres\)/);
    expect(card.textContent).toMatch(/reachable · version sha-1234abcd/);
    expect(card.dataset['tone']).toBe('ok');
  });

  it('names the database during an outage', async () => {
    render(
      await PlatformHealthCard({
        health: {
          reachable: true,
          body: {
            status: 'error',
            checks: { database: 'unreachable' },
            kg: {
              backend: 'neon',
              embeddings: true,
              semanticRecall: true,
              pool: 'dead',
              warnings: ['pg pool is not usable'],
            },
          },
        },
      }),
    );
    const card = screen.getByTestId('platform-health-card');
    expect(card.dataset['tone']).toBe('danger');
    expect(card.textContent).toMatch(/not answering\. Check that Postgres is running and DATABASE_URL is right/);
    expect(card.textContent).toMatch(/pg pool is not usable/);
  });

  it('says the middleware did not answer when /health is unreachable', async () => {
    render(await PlatformHealthCard({ health: { reachable: false } }));
    expect(screen.getByTestId('platform-health-unreachable')).toBeTruthy();
    expect(screen.getByTestId('platform-health-card').dataset['tone']).toBe('danger');
  });
});

describe('<VaultStatusCard /> — keychain master key (#1387)', () => {
  it('shows the keychain key and no "production" claim with only VAULT_KEY set', async () => {
    render(
      await VaultStatusCard({
        status: vaultStatus({ keychain_key_source: 'dev-file-existed', production_ready: false }),
      }),
    );
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/Keychain master key/);
    expect(text).toMatch(/dev file, set CREDENTIAL_KEYCHAIN_KEY for production/);
    expect(text).toMatch(/VAULT_KEY \(env\)/);
    expect(text).not.toMatch(/— production/);
    expect(text).toMatch(/Warning/);
  });

  it('reads OK when both keys come from env', async () => {
    render(await VaultStatusCard({ status: vaultStatus() }));
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/CREDENTIAL_KEYCHAIN_KEY \(env\)/);
    expect(text).not.toMatch(/Warning/);
  });

  it('says so when an older middleware does not report the keychain key', async () => {
    const status = vaultStatus();
    delete status.vault.keychain_key_source;
    render(await VaultStatusCard({ status }));
    expect(document.body.textContent).toMatch(/not reported by this middleware version/);
  });
});
