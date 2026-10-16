import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import { PlatformHealthBanner } from '../PlatformHealthBanner';

/** #1332 / #1384 — the shared banner on the dashboard and /admin. */

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }): React.ReactElement => <a href={href}>{children}</a>,
}));

describe('<PlatformHealthBanner />', () => {
  it('renders nothing without a notice', () => {
    renderWithIntl(<PlatformHealthBanner notice={null} />, { locale: 'en' });
    expect(screen.queryByTestId('platform-health-banner')).toBeNull();
  });

  it('names the database and links to /system, without a dismiss', () => {
    renderWithIntl(<PlatformHealthBanner notice={{ kind: 'databaseUnreachable' }} />, {
      locale: 'en',
    });
    const banner = screen.getByTestId('platform-health-banner');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toMatch(/Database unreachable/);
    expect(banner.textContent).toMatch(/Postgres/);
    expect(banner.querySelector('a')?.getAttribute('href')).toBe('/system');
    expect(screen.queryByRole('button', { name: 'Later' })).toBeNull();
  });

  it('names the missing env var for the dev key and can be dismissed', () => {
    renderWithIntl(
      <PlatformHealthBanner notice={{ kind: 'devMasterKey', which: 'keychain' }} />,
      { locale: 'en' },
    );
    const banner = screen.getByTestId('platform-health-banner');
    expect(banner.textContent).toMatch(/CREDENTIAL_KEYCHAIN_KEY is not set/);
    expect(banner.textContent).not.toMatch(/VAULT_KEY and/);
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByTestId('platform-health-banner')).toBeNull();
  });

  it('names both keys in German when both are dev keys', () => {
    renderWithIntl(<PlatformHealthBanner notice={{ kind: 'devMasterKey', which: 'both' }} />, {
      locale: 'de',
    });
    expect(screen.getByTestId('platform-health-banner').textContent).toMatch(
      /VAULT_KEY und CREDENTIAL_KEYCHAIN_KEY sind nicht gesetzt/,
    );
  });
});
