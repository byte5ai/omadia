import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../../messages/en.json';
import type { PrivacyNameDetector, PrivacyPosture } from '../../../_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import { NameDetectorBanner } from '../../NameDetectorBanner';
import { NameDetectorStatus } from '../NameDetectorStatus';

/**
 * #1562 — whether the Privacy Guard's C1 name detector runs used to show only
 * in a boot-log line. The guard's store page shows its state; the dashboard
 * and `/admin` warn when the shield runs without it.
 */

const { mockGetPosture } = vi.hoisted(() => ({ mockGetPosture: vi.fn() }));

vi.mock('../../../_lib/api', () => ({ getPrivacyPosture: mockGetPosture }));

const t = en.privacyNameDetector;

function posture(
  nameDetector: PrivacyNameDetector | null | undefined,
  shieldActive = true,
): PrivacyPosture {
  return {
    shield_active: shieldActive,
    force_guarded: false,
    provider_ids: ['@omadia/plugin-privacy-guard'],
    ...(nameDetector !== undefined ? { name_detector: nameDetector } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NameDetectorStatus (#1562)', () => {
  it.each([
    [{ state: 'unconfigured', source: null, last_failure_at: null }, t.stateOff],
    [{ state: 'active', source: 'setup', last_failure_at: null }, t.stateActiveSetup],
    [{ state: 'active', source: 'env', last_failure_at: null }, t.stateActiveEnv],
    [{ state: 'unreachable', source: 'env', last_failure_at: null }, t.stateUnreachable],
  ] as Array<[PrivacyNameDetector, string]>)('renders %o', async (detector, text) => {
    mockGetPosture.mockResolvedValue(posture(detector));
    renderWithIntl(<NameDetectorStatus />);
    const box = await screen.findByTestId('name-detector-status');
    expect(box.textContent).toContain(t.label);
    expect(box.textContent).toContain(text);
    expect(box.textContent).not.toContain('Last failed');
  });

  it('names the last failure during a turn', async () => {
    mockGetPosture.mockResolvedValue(
      posture({ state: 'active', source: 'setup', last_failure_at: '2026-10-29T08:15:00.000Z' }),
    );
    renderWithIntl(<NameDetectorStatus />);
    const box = await screen.findByTestId('name-detector-status');
    expect(box.textContent).toMatch(/Last failed during a turn: .*2026/);
  });

  it.each([
    ['an older backend without the field', posture(undefined)],
    ['no shield running', posture(null, false)],
  ])('renders nothing for %s', async (_label, value) => {
    mockGetPosture.mockResolvedValue(value);
    const { container } = renderWithIntl(<NameDetectorStatus />);
    await waitFor(() => expect(mockGetPosture).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.textContent).toBe('');
  });

  it('renders nothing when the posture cannot be read', async () => {
    mockGetPosture.mockRejectedValue(new Error('down'));
    const { container } = renderWithIntl(<NameDetectorStatus />);
    await waitFor(() => expect(mockGetPosture).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});

describe('NameDetectorBanner (#1562)', () => {
  it('warns when prompt masking is on but C1 is not configured, and links to the guard', () => {
    renderWithIntl(
      <NameDetectorBanner
        posture={posture({
          state: 'unconfigured',
          source: null,
          last_failure_at: null,
          prompt_masking: true,
        })}
      />,
    );
    const banner = screen.getByTestId('name-detector-banner');
    expect(banner.textContent).toContain(t.bannerTitleOff);
    expect(banner.getAttribute('role')).toBe('status');
    expect(screen.getByRole('link', { name: t.cta }).getAttribute('href')).toBe(
      '/store/%40omadia%2Fplugin-privacy-guard',
    );
  });

  it('warns when C1 is unreachable', () => {
    renderWithIntl(
      <NameDetectorBanner
        posture={posture({ state: 'unreachable', source: 'setup', last_failure_at: null })}
      />,
    );
    expect(screen.getByTestId('name-detector-banner').textContent).toContain(
      t.bannerTitleUnreachable,
    );
  });

  it('stays silent when C1 is active, the shield is off, or the state is unknown', () => {
    const { container } = renderWithIntl(
      <>
        <NameDetectorBanner
          posture={posture({ state: 'active', source: 'env', last_failure_at: null })}
        />
        <NameDetectorBanner
          posture={posture({ state: 'unconfigured', source: null, last_failure_at: null }, false)}
        />
        <NameDetectorBanner posture={posture(undefined)} />
        <NameDetectorBanner posture={posture(null)} />
        <NameDetectorBanner posture={null} />
        {/* a default install: prompt masking off, no sidecar */}
        <NameDetectorBanner
          posture={posture({
            state: 'unconfigured',
            source: null,
            last_failure_at: null,
            prompt_masking: false,
          })}
        />
      </>,
    );
    expect(container.textContent).toBe('');
  });
});
