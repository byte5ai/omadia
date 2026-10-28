import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enMessages from '../../../messages/en.json';

/**
 * #1332 — a vault on the dev master key was flagged on /system only. /admin had
 * no card for /system and no warning; the "System" group held "Update" alone.
 */

const { mockFetchHealth, mockGetVaultStatus, mockGetPrivacyPosture } = vi.hoisted(() => ({
  mockFetchHealth: vi.fn(),
  mockGetVaultStatus: vi.fn(),
  mockGetPrivacyPosture: vi.fn(),
}));

vi.mock('../../_lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../_lib/api')>()),
  getVaultStatus: mockGetVaultStatus,
  getPrivacyPosture: mockGetPrivacyPosture,
}));

vi.mock('../../_lib/navigation', () => ({
  fetchNavEntries: vi.fn(async () => []),
}));

vi.mock('../../_lib/platformHealth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../_lib/platformHealth')>()),
  fetchMiddlewareHealth: mockFetchHealth,
}));

vi.mock('../../_components/PlatformHealthBanner', () => ({
  PlatformHealthBanner: ({
    notice,
  }: {
    notice: { kind: string } | null;
  }): React.ReactElement | null =>
    notice === null ? null : (
      <div data-testid="platform-health-banner" data-kind={notice.kind} />
    ),
}));

vi.mock('../../_components/PrivacyShieldBanner', () => ({
  PrivacyShieldBanner: ({
    posture,
  }: {
    posture: { shield_active: boolean } | null;
  }): React.ReactElement | null =>
    posture === null || posture.shield_active ? null : (
      <div data-testid="privacy-shield-banner" />
    ),
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }): React.ReactElement => <a href={href}>{children}</a>,
}));

vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: enMessages as Record<string, unknown>,
      namespace,
    }),
}));

import AdminIndexPage from '../page';

/** A vault status with the given key sources (#1332 / #1387). */
function vaultWith(
  vaultKey: 'env' | 'dev-file-existed',
  keychainKey: 'env' | 'dev-file-existed',
): unknown {
  return {
    vault: {
      path: '/data/vault.enc',
      data_dir: '/data',
      exists: true,
      size_bytes: 1,
      last_modified: null,
      agent_count: 0,
      master_key_source: vaultKey,
      keychain_key_source: keychainKey,
      production_ready: vaultKey === 'env' && keychainKey === 'env',
    },
    backup: { enabled: false },
  };
}


beforeEach(() => {
  vi.clearAllMocks();
  mockGetPrivacyPosture.mockResolvedValue({
    shield_active: true,
    force_guarded: false,
    provider_ids: ['@omadia/plugin-privacy-guard'],
  });
});

describe('/admin — platform health (#1332)', () => {
  it('links to /system from the System group', async () => {
    mockFetchHealth.mockResolvedValue({
      reachable: true,
      body: { checks: { database: 'ok' } },
    });
    mockGetVaultStatus.mockResolvedValue(vaultWith('env', 'env'));
    render(await AdminIndexPage());

    const link = screen.getByText('Platform health').closest('a');
    expect(link?.getAttribute('href')).toBe('/system');
    expect(screen.queryByTestId('platform-health-banner')).toBeNull();
  });

  it('warns about the dev master key', async () => {
    mockFetchHealth.mockResolvedValue({
      reachable: true,
      body: { checks: { database: 'ok' } },
    });
    mockGetVaultStatus.mockResolvedValue(vaultWith('dev-file-existed', 'dev-file-existed'));
    render(await AdminIndexPage());

    expect(screen.getByTestId('platform-health-banner').dataset['kind']).toBe('devMasterKey');
  });
});

describe('/admin — Privacy Shield off (#1507)', () => {
  it('warns when no Privacy Guard is running', async () => {
    mockFetchHealth.mockResolvedValue({
      reachable: true,
      body: { checks: { database: 'ok' } },
    });
    mockGetVaultStatus.mockResolvedValue(vaultWith('env', 'env'));
    mockGetPrivacyPosture.mockResolvedValue({
      shield_active: false,
      force_guarded: false,
      provider_ids: [],
    });
    render(await AdminIndexPage());
    expect(screen.getByTestId('privacy-shield-banner')).toBeTruthy();
  });
});
