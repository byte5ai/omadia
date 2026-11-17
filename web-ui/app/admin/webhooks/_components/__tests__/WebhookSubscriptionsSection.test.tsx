import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import de from '../../../../../messages/de.json';
import { ApiError, type ConductorWebhookSubscription } from '../../../../_lib/api';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { WebhookSubscriptionsSection } from '../WebhookSubscriptionsSection';

const { mockList, mockCreate, mockRotate, mockDelete, mockIncludeContext } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockCreate: vi.fn(),
  mockRotate: vi.fn(),
  mockDelete: vi.fn(),
  mockIncludeContext: vi.fn(),
}));

vi.mock('../../../../_lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/api')>()),
  listWebhookSubscriptions: mockList,
  createWebhookSubscription: mockCreate,
  rotateWebhookSubscriptionSecret: mockRotate,
  deleteWebhookSubscription: mockDelete,
  setWebhookSubscriptionIncludeContext: mockIncludeContext,
}));

function sub(id: string, over: Partial<ConductorWebhookSubscription> = {}): ConductorWebhookSubscription {
  return {
    id,
    url: `https://example.com/${id}`,
    event: 'run.completed',
    description: null,
    enabled: true,
    // #1707 — mirrors the column default: a subscription sends no step results
    // until an operator opts in.
    includeContext: false,
    createdBy: 'admin',
    createdAt: '2026-10-01T00:00:00Z',
    ...over,
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

// #1707 — the run-context opt-in. A delivery used to carry the run's whole `context`
// (every step result, including free text a person typed into an approval) with
// nothing in this UI to see or change that.
describe('<WebhookSubscriptionsSection /> — run-context opt-in (#1707)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIncludeContext.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('labels a subscription that sends no step results, and one that does', async () => {
    mockList.mockResolvedValue({ subscriptions: [sub('a'), sub('b', { includeContext: true })] });
    renderWithIntl(<WebhookSubscriptionsSection />, { locale: 'de' });

    expect(await screen.findByText(de.adminWebhooks.badge.contextOff)).toBeTruthy();
    expect(screen.getByText(de.adminWebhooks.badge.contextOn)).toBeTruthy();
  });

  it('creates with the opt-in OFF unless the box is ticked', async () => {
    mockList.mockResolvedValue({ subscriptions: [] });
    mockCreate.mockResolvedValue({ subscription: sub('a'), secret: 'a'.repeat(64) });
    renderWithIntl(<WebhookSubscriptionsSection />, { locale: 'de' });

    const input = await screen.findByPlaceholderText('https://example.com/hook');
    fireEvent.change(input, { target: { value: 'https://example.com/hook' } });
    fireEvent.click(screen.getByText(t.create));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({ includeContext: false });
  });

  it('ticking the box opts the new subscription in', async () => {
    mockList.mockResolvedValue({ subscriptions: [] });
    mockCreate.mockResolvedValue({ subscription: sub('a', { includeContext: true }), secret: 'b'.repeat(64) });
    renderWithIntl(<WebhookSubscriptionsSection />, { locale: 'de' });

    const input = await screen.findByPlaceholderText('https://example.com/hook');
    fireEvent.change(input, { target: { value: 'https://example.com/hook' } });
    fireEvent.click(screen.getByLabelText(t.fields.includeContext));
    fireEvent.click(screen.getByText(t.create));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({ includeContext: true });
  });

  it('switching the context ON asks first, and does nothing when declined', async () => {
    mockList.mockResolvedValue({ subscriptions: [sub('a')] });
    vi.stubGlobal('confirm', () => false);
    renderWithIntl(<WebhookSubscriptionsSection />, { locale: 'de' });

    // By role, not by text: the create form's checkbox label is a different control
    // with a near-identical name, and clicking it would prove nothing.
    fireEvent.click(await screen.findByRole('button', { name: t.includeContext }));
    await waitFor(() => expect(mockIncludeContext).not.toHaveBeenCalled());
  });

  it('switching it ON after confirming calls through; switching it OFF needs no confirmation', async () => {
    mockList.mockResolvedValue({ subscriptions: [sub('a')] });
    vi.stubGlobal('confirm', () => true);
    renderWithIntl(<WebhookSubscriptionsSection />, { locale: 'de' });

    fireEvent.click(await screen.findByRole('button', { name: t.includeContext }));
    await waitFor(() => expect(mockIncludeContext).toHaveBeenCalledWith('a', true));

    vi.clearAllMocks();
    vi.stubGlobal('confirm', () => {
      throw new Error('turning the context OFF must not prompt');
    });
    mockList.mockResolvedValue({ subscriptions: [sub('a', { includeContext: true })] });
    renderWithIntl(<WebhookSubscriptionsSection />, { locale: 'de' });
    fireEvent.click((await screen.findAllByRole('button', { name: t.excludeContext }))[0]!);
    await waitFor(() => expect(mockIncludeContext).toHaveBeenCalledWith('a', false));
  });
});
