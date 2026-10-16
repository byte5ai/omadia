import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import de from '../../../../../messages/de.json';
import { ApiError, type ConductorWebhookSubscription } from '../../../../_lib/api';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { WebhookSubscriptionsSection } from '../WebhookSubscriptionsSection';

const { mockList, mockCreate, mockRotate, mockDelete } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockCreate: vi.fn(),
  mockRotate: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock('../../../../_lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/api')>()),
  listWebhookSubscriptions: mockList,
  createWebhookSubscription: mockCreate,
  rotateWebhookSubscriptionSecret: mockRotate,
  deleteWebhookSubscription: mockDelete,
}));

function sub(id: string): ConductorWebhookSubscription {
  return {
    id,
    url: `https://example.com/${id}`,
    event: 'run.completed',
    description: null,
    enabled: true,
    createdBy: 'admin',
    createdAt: '2026-10-01T00:00:00Z',
  };
}

const t = de.adminWebhooks.subscriptions;

describe('<WebhookSubscriptionsSection />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });
  afterEach(() => vi.clearAllMocks());

  it('#1338: shows a forbidden URL as localized copy at the URL field, not raw JSON', async () => {
    mockList.mockResolvedValue({ subscriptions: [] });
    mockCreate.mockRejectedValue(
      new ApiError(
        400,
        'POST failed: 400',
        '{"code":"conductor.webhook_url_forbidden","message":"invalid URL \'not a url\'"}',
      ),
    );
    renderWithIntl(<WebhookSubscriptionsSection />, { locale: 'de' });

    const input = await screen.findByPlaceholderText('https://example.com/hook');
    fireEvent.change(input, { target: { value: 'not a url' } });
    fireEvent.click(screen.getByText(t.create));

    expect(await screen.findByText(de.adminWebhooks.errors.urlForbidden)).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.body.textContent).not.toContain('"code"');
  });

  it('#1339: a revealed secret has a copy button and blocks another rotate', async () => {
    mockList.mockResolvedValue({ subscriptions: [sub('a'), sub('b')] });
    mockRotate.mockResolvedValue({ secret: 'f'.repeat(64) });
    renderWithIntl(<WebhookSubscriptionsSection />, { locale: 'de' });

    const rotateButtons = await screen.findAllByText(t.rotateSecret);
    fireEvent.click(rotateButtons[0]!);

    expect(await screen.findByText('f'.repeat(64))).toBeTruthy();
    fireEvent.click(screen.getByText(de.oneTimeSecret.copy));
    expect(await screen.findByText(de.oneTimeSecret.copied)).toBeTruthy();

    // A second rotate while the first secret is on screen would replace it.
    fireEvent.click(screen.getAllByText(t.rotateSecret)[1]!);
    await waitFor(() => expect(mockRotate).toHaveBeenCalledTimes(1));
    expect(screen.getByText(t.blockedByReveal)).toBeTruthy();

    fireEvent.click(screen.getByText(de.oneTimeSecret.dismiss));
    expect(screen.queryByText('f'.repeat(64))).toBeNull();
    expect(screen.queryByText(t.blockedByReveal)).toBeNull();
  });

  it('#1339: the secret stays dismissible when its row is deleted', async () => {
    mockList.mockResolvedValueOnce({ subscriptions: [sub('a')] });
    mockRotate.mockResolvedValue({ secret: 'e'.repeat(64) });
    mockDelete.mockResolvedValue(undefined);
    vi.stubGlobal('confirm', () => true);
    renderWithIntl(<WebhookSubscriptionsSection />, { locale: 'de' });

    fireEvent.click(await screen.findByText(t.rotateSecret));
    expect(await screen.findByText('e'.repeat(64))).toBeTruthy();

    mockList.mockResolvedValueOnce({ subscriptions: [] });
    fireEvent.click(screen.getByText(t.delete));
    expect(await screen.findByText(t.empty)).toBeTruthy();

    // The row is gone; the secret and its dismiss button are not.
    expect(screen.getByText('e'.repeat(64))).toBeTruthy();
    fireEvent.click(screen.getByText(de.oneTimeSecret.dismiss));
    expect(screen.queryByText(t.blockedByReveal)).toBeNull();
    vi.unstubAllGlobals();
  });
});
