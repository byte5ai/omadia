import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranslations } from 'next-intl';

import { renderWithIntl } from '../../../../_lib/test-utils';
import { ChatGptConnectModal } from '../ChatGptConnectModal';

/**
 * #294 — the "Sign in with ChatGPT" device-code modal. It must start the flow,
 * show the user code + verification link + the ToS caveat, poll on the
 * server-supplied interval, and fire onConnected exactly once on completion.
 */
const { mockStart, mockPoll } = vi.hoisted(() => ({
  mockStart: vi.fn(),
  mockPoll: vi.fn(),
}));

vi.mock('../../../../_lib/api', () => ({
  startProviderOAuth: mockStart,
  pollProviderOAuth: mockPoll,
}));

/** Bridge the real message catalog into the component's `t` for the test. */
function Harness(props: {
  onClose: () => void;
  onConnected: () => void;
}): React.ReactElement {
  const t = useTranslations('adminProviders');
  return (
    <ChatGptConnectModal
      providerId="openai-chatgpt"
      t={t}
      onClose={props.onClose}
      onConnected={props.onConnected}
    />
  );
}

describe('<ChatGptConnectModal />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('shows the user code, the verification link and the ToS notice', async () => {
    mockStart.mockResolvedValue({
      flowId: 'f1',
      userCode: 'ABCD-1234',
      verificationUri: 'https://auth.openai.com/codex/device',
      interval: 5,
    });
    mockPoll.mockResolvedValue({ status: 'pending' });

    renderWithIntl(<Harness onClose={() => {}} onConnected={() => {}} />, {
      locale: 'en',
    });

    expect(await screen.findByTestId('oauth-user-code')).toHaveTextContent('ABCD-1234');
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://auth.openai.com/codex/device');
    // The experimental / ToS caveat must always be visible.
    expect(screen.getByText(/grey area of OpenAI/i)).toBeTruthy();
  });

  it('fires onConnected when a poll reports complete', async () => {
    mockStart.mockResolvedValue({
      flowId: 'f1',
      userCode: 'X',
      verificationUri: 'https://x/codex/device',
      interval: 0.05, // fast poll for the test
    });
    mockPoll.mockResolvedValueOnce({ status: 'pending' }).mockResolvedValue({ status: 'complete' });
    const onConnected = vi.fn();

    renderWithIntl(<Harness onClose={() => {}} onConnected={onConnected} />, {
      locale: 'en',
    });

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
  });

  it('offers a retry when the flow expires', async () => {
    mockStart.mockResolvedValue({
      flowId: 'f1',
      userCode: 'X',
      verificationUri: 'https://x/codex/device',
      interval: 0.05,
    });
    mockPoll.mockResolvedValue({ status: 'expired' });

    renderWithIntl(<Harness onClose={() => {}} onConnected={() => {}} />, {
      locale: 'en',
    });

    const retry = await screen.findByRole('button', { name: /Try again/i });
    expect(retry).toBeTruthy();
    // Retrying restarts the flow.
    mockStart.mockClear();
    fireEvent.click(retry);
    await waitFor(() => expect(mockStart).toHaveBeenCalled());
  });
});
