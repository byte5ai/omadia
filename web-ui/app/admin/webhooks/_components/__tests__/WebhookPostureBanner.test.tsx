import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import de from '../../../../../messages/de.json';
import { ApiError } from '../../../../_lib/api';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { WebhookPostureBanner } from '../WebhookPostureBanner';

// #1707 — the kill switch was invisible. With CONDUCTOR_WEBHOOKS_ENABLED=false every
// inbound request was answered `200 {"outcome":"disabled"}`: senders saw success, the
// log printed its usual mount line, and this page showed no state at all. The banner
// is the page's answer to "is anything being processed here".

const { mockPosture } = vi.hoisted(() => ({ mockPosture: vi.fn() }));

vi.mock('../../../../_lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/api')>()),
  getWebhookPosture: mockPosture,
}));

const t = de.adminWebhooks.posture;

describe('<WebhookPostureBanner /> (#1707)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it('says so loudly when inbound deliveries are switched off', async () => {
    mockPosture.mockResolvedValue({ posture: { configured: true, inboundEnabled: false } });
    renderWithIntl(<WebhookPostureBanner />, { locale: 'de' });

    expect(await screen.findByText(t.inboundOff)).toBeTruthy();
    expect(screen.getByText(t.inboundOffDetail)).toBeTruthy();
  });

  it('distinguishes "switched off" from "this server has no Conductor at all"', async () => {
    mockPosture.mockResolvedValue({ posture: { configured: false, inboundEnabled: false } });
    renderWithIntl(<WebhookPostureBanner />, { locale: 'de' });

    expect(await screen.findByText(t.inboundOff)).toBeTruthy();
    expect(screen.getByText(t.notConfiguredDetail)).toBeTruthy();
  });

  it('states the hardening windows in force when inbound is on', async () => {
    mockPosture.mockResolvedValue({
      posture: {
        configured: true,
        inboundEnabled: true,
        requireTimestamp: false,
        timestampToleranceSeconds: 300,
        secretGraceSeconds: 3600,
        maxInboundDeliveriesPerMinute: 60,
        payloadRetentionDays: 30,
        deliveryRetentionDays: 180,
      },
    });
    renderWithIntl(<WebhookPostureBanner />, { locale: 'de' });

    expect(await screen.findByText(t.inboundOn)).toBeTruthy();
    // The replay window must say which of the two postures is active — "senders
    // without a timestamp are still accepted" is the one that leaves it open.
    expect(screen.getByText(/300/)).toBeTruthy();
    expect(document.body.textContent).toContain(t.timestampOptional);
    expect(document.body.textContent).not.toContain(t.timestampRequired);
  });

  it('reports a required timestamp as the closed posture', async () => {
    mockPosture.mockResolvedValue({
      posture: { configured: true, inboundEnabled: true, requireTimestamp: true, timestampToleranceSeconds: 120 },
    });
    renderWithIntl(<WebhookPostureBanner />, { locale: 'de' });

    expect(await screen.findByText(t.inboundOn)).toBeTruthy();
    expect(document.body.textContent).toContain(t.timestampRequired);
  });

  // On a DB-less install the entire Conductor operator router is unmounted, so this
  // route 404s and the server's own `configured: false` answer never arrives. The
  // banner used to show a red request-failed line for that.
  it('reads a 404 as "no webhook surface here", not as a failure', async () => {
    mockPosture.mockRejectedValue(new ApiError(404, 'GET failed: 404', ''));
    renderWithIntl(<WebhookPostureBanner />, { locale: 'de' });

    expect(await screen.findByText(t.inboundOff)).toBeTruthy();
    expect(screen.getByText(t.notConfiguredDetail)).toBeTruthy();
    expect(screen.queryByText(de.adminWebhooks.errors.requestFailed.replace('{status}', '404'))).toBeNull();
  });

  it('renders the failure rather than nothing — "we cannot tell you" is information too', async () => {
    mockPosture.mockRejectedValue(new ApiError(500, 'GET failed: 500', '{"code":"conductor.webhook_posture_failed"}'));
    renderWithIntl(<WebhookPostureBanner />, { locale: 'de' });

    expect(await screen.findByText(de.adminWebhooks.errors.serverFailed)).toBeTruthy();
  });
});
