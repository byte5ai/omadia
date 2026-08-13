import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import { SubscriptionClisPanel } from '../SubscriptionClisPanel';
import type { CliBackendStatus } from '../../../../_lib/api';

/**
 * OM-11 + OM-22.
 *
 * OM-11: the customer clicked "Anmelden →" and landed on this panel showing
 * "NICHT GEFUNDEN – In dieser Umgebung nicht installiert", with no login button
 * and no way to get the CLI onto the server. The install instructions DID exist
 * — but behind `canConnect = b.installed && …`, i.e. hidden precisely when
 * `!installed`, which is exactly when they are needed.
 *
 * OM-22: "Erneut prüfen" appeared to do nothing. `generatedAt` was already on
 * the wire and had zero render sites.
 */

const { mockGetCliBackends } = vi.hoisted(() => ({
  mockGetCliBackends: vi.fn(),
}));

vi.mock('../../../../_lib/api', () => ({
  getCliBackends: mockGetCliBackends,
  startCliLogin: vi.fn(),
  submitCliLoginCode: vi.fn(),
  cancelCliLogin: vi.fn(),
  cliLogout: vi.fn(),
}));

function backend(over: Partial<CliBackendStatus> = {}): CliBackendStatus {
  return {
    id: 'claude',
    label: 'Claude',
    bin: 'claude',
    installed: true,
    loggedIn: 'no',
    billing: 'subscription',
    detail: 'Installed but not logged in.',
    ...over,
  } as CliBackendStatus;
}

describe('<SubscriptionClisPanel />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('OM-11: an uninstalled CLI shows NO connect button but DOES show install help', async () => {
    mockGetCliBackends.mockResolvedValue({
      backends: [
        backend({
          installed: false,
          detail: 'claude is not installed in this environment.',
        }),
      ],
      generatedAt: Date.now(),
    });

    renderWithIntl(<SubscriptionClisPanel onSwitchToProviders={() => {}} />, {
      locale: 'de',
    });

    // The dead end: no in-app login is possible without the binary…
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Jetzt anmelden|Verbinden/i })).toBeNull();
    });

    // …so the way OUT of the dead end must be visible instead.
    expect(screen.getByText(/CLI installieren/)).toBeTruthy();
    expect(
      screen.getByText(/npm install -g @anthropic-ai\/claude-code/),
    ).toBeTruthy();
  });

  it('OM-22: renders the snapshot timestamp so a re-check is observable', async () => {
    mockGetCliBackends.mockResolvedValue({
      backends: [backend({ installed: false })],
      generatedAt: Date.parse('2026-08-03T09:41:07Z'),
    });

    renderWithIntl(<SubscriptionClisPanel onSwitchToProviders={() => {}} />, {
      locale: 'de',
    });

    const el = await screen.findByTestId('cli-last-checked');
    expect(el.textContent).toMatch(/Zuletzt geprüft/);
    // A real time, not an empty interpolation.
    expect(el.textContent).toMatch(/\d{1,2}:\d{2}/);
  });

  it('an installed CLI still offers the in-app login', async () => {
    mockGetCliBackends.mockResolvedValue({
      backends: [backend({ installed: true, loggedIn: 'no' })],
      generatedAt: Date.now(),
    });

    renderWithIntl(<SubscriptionClisPanel onSwitchToProviders={() => {}} />, {
      locale: 'de',
    });

    // The connect box renders; the install steps stay collapsed behind the
    // existing <details>, exactly as before.
    await waitFor(() => {
      expect(screen.queryByText(/CLI installieren/)).toBeNull();
    });
    expect(
      screen.getByText(/npm install -g @anthropic-ai\/claude-code/),
    ).toBeTruthy();
  });
});
