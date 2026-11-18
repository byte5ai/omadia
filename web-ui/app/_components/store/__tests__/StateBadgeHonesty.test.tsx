import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithIntl } from '../../../_lib/test-utils';
import type { PluginReadiness } from '../../../_lib/storeTypes';
import { StateBadge } from '../StateBadge';

/**
 * Issue #1453 — the badge must not claim more than the kernel knows.
 *
 * `readiness.verified_at` is the time of the plugin's last ACTIVATION, not of
 * a credential check: nothing in omadia contacted the target system. The badge
 * used to render it as "Active · configured {time}", which reads as a check
 * that never happened — and it kept reading that way while the plugin's own
 * status said the API key had been refused.
 */

const READY: PluginReadiness = {
  state: 'ready',
  missing_fields: [],
  verified_at: '2026-10-22T08:03:00.000Z',
};

describe('StateBadge — what the green badge is allowed to claim (#1453)', () => {
  it('does not describe an activation timestamp as a configuration check', () => {
    renderWithIntl(<StateBadge state="installed" readiness={READY} />);

    const badge = screen.getByText(/Active/);
    expect(badge.textContent).not.toMatch(/configured/i);
    expect(badge.textContent).toMatch(/since/i);
  });

  it('reports a refused credential as its own red state, not as green', () => {
    // The server derives `connection_failed` from the same reported error
    // (`computeReadiness`, #1453), so the badge never has to sit next to a red
    // pill still claiming health.
    renderWithIntl(
      <StateBadge
        state="installed"
        readiness={{ ...READY, state: 'connection_failed', verified_at: null }}
        actionStatus={{
          state: 'error',
          title: 'Nicht verbunden',
          detail: 'Odoo hat den API-Key abgelehnt',
          checked_at: '2026-10-22T08:33:00.000Z',
        }}
      />,
    );

    const badge = screen.getByText(/Connection failed/i);
    expect(badge).toBeTruthy();
    expect(badge.getAttribute('title')).toBe('Odoo hat den API-Key abgelehnt');
    expect(screen.queryByText(/since/i)).toBeNull();
    expect(screen.queryByText(/^Installed$/i)).toBeNull();
  });

  it('still drops the timestamp if a stale ready payload arrives with a reported error', () => {
    // Defence in depth: an older middleware (or a cached response) can hand
    // the UI `ready` next to a reported error. The badge must not render the
    // green claim just because the server failed to downgrade the state.
    renderWithIntl(
      <StateBadge
        state="installed"
        readiness={READY}
        actionStatus={{ state: 'error', title: 'Nicht verbunden' }}
      />,
    );

    expect(screen.queryByText(/since/i)).toBeNull();
  });

  it('drops the claim for a pending action too', () => {
    renderWithIntl(
      <StateBadge
        state="installed"
        readiness={READY}
        actionStatus={{ state: 'needs_action', title: 'Connect your account' }}
      />,
    );

    expect(screen.queryByText(/since/i)).toBeNull();
  });

  it('keeps the timestamp when the reported status is positive', () => {
    renderWithIntl(
      <StateBadge
        state="installed"
        readiness={READY}
        actionStatus={{ state: 'ok', title: 'Verbunden' }}
      />,
    );

    expect(screen.getByText(/since/i)).toBeTruthy();
  });

  it('renders exactly as before when no status was reported', () => {
    renderWithIntl(<StateBadge state="installed" readiness={READY} />);
    expect(screen.getByText(/Active/)).toBeTruthy();
  });
});
