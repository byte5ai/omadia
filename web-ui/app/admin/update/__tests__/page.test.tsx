import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import UpdatePage from '../page';

/**
 * Coverage for /admin/update (#432).
 *
 * The page's job is to be honest about which of three capability tiers is
 * active, and to make the destructive action reachable ONLY in the tier that
 * can actually carry it out. Each test below pins one of those tiers, plus the
 * type-to-confirm gate that stands in front of the trigger.
 */

const { mockGetUpdateStatus, mockGetUpdateHistory, mockTriggerUpdate } = vi.hoisted(
  () => ({
    mockGetUpdateStatus: vi.fn(),
    mockGetUpdateHistory: vi.fn(),
    mockTriggerUpdate: vi.fn(),
  }),
);

vi.mock('../../../_lib/api', () => ({
  ApiError: class ApiError extends Error {
    public readonly code: string | null;
    constructor(
      public status: number,
      message: string,
      public body = '',
    ) {
      super(message);
      this.name = 'ApiError';
      try {
        this.code = (JSON.parse(body) as { error?: string }).error ?? null;
      } catch {
        this.code = null;
      }
    }
  },
  getUpdateStatus: mockGetUpdateStatus,
  getUpdateHistory: mockGetUpdateHistory,
  triggerUpdate: mockTriggerUpdate,
}));

function status(overrides: Record<string, unknown> = {}) {
  return {
    current: { version: 'v0.74.0', source: 'release' },
    latest: {
      tag: 'v0.75.0',
      url: 'https://github.com/byte5ai/omadia/releases/tag/v0.75.0',
      publishedAt: '2026-08-13T13:00:41Z',
      prerelease: false,
    },
    updateAvailable: true,
    check: { checkedAt: 1, stale: false },
    executor: { configured: true, reachable: true, state: 'idle', steps: [] },
    auditAvailable: true,
    ...overrides,
  };
}

beforeEach(() => {
  mockGetUpdateStatus.mockResolvedValue(status());
  mockGetUpdateHistory.mockResolvedValue({ entries: [], available: true });
  mockTriggerUpdate.mockResolvedValue({
    accepted: true,
    targetVersion: 'v0.75.0',
    auditId: 'a1',
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('/admin/update', () => {
  it('reports the running version and that a newer release exists', async () => {
    renderWithIntl(<UpdatePage />);

    await waitFor(() => {
      expect(screen.getByText('v0.74.0')).toBeInTheDocument();
    });
    // The release renders as a link to its GitHub page — matched by role so
    // it is not confused with the confirm placeholder or the button label.
    expect(screen.getByRole('link', { name: 'v0.75.0' })).toHaveAttribute(
      'href',
      'https://github.com/byte5ai/omadia/releases/tag/v0.75.0',
    );
    expect(screen.getByText(/v0\.75\.0 is available/i)).toBeInTheDocument();
  });

  it('flags an unstamped build instead of showing a version it cannot know', async () => {
    mockGetUpdateStatus.mockResolvedValue(
      status({
        current: { version: 'unknown', source: 'unknown' },
        updateAvailable: false,
      }),
    );
    renderWithIntl(<UpdatePage />);

    await waitFor(() => {
      expect(screen.getByText(/build not stamped/i)).toBeInTheDocument();
    });
  });

  it('offers the manual command instead of a button when no updater is configured', async () => {
    mockGetUpdateStatus.mockResolvedValue(
      status({ executor: { configured: false, reachable: false } }),
    );
    renderWithIntl(<UpdatePage />);

    await waitFor(() => {
      expect(screen.getByText(/no updater is configured/i)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/OMADIA_VERSION=v0\.75\.0 docker compose up -d/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /update to/i }),
    ).not.toBeInTheDocument();
  });

  it('says so when the updater is configured but unreachable', async () => {
    mockGetUpdateStatus.mockResolvedValue(
      status({
        executor: { configured: true, reachable: false, error: 'ECONNREFUSED' },
      }),
    );
    renderWithIntl(<UpdatePage />);

    await waitFor(() => {
      expect(screen.getByText(/did not answer/i)).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('button', { name: /update to/i }),
    ).not.toBeInTheDocument();
  });

  it('keeps the trigger disabled until the target version is retyped exactly', async () => {
    const user = userEvent.setup();
    renderWithIntl(<UpdatePage />);

    const button = await screen.findByRole('button', { name: /update to v0\.75\.0/i });
    expect(button).toBeDisabled();

    const input = screen.getByLabelText(/target version/i);
    await user.type(input, 'v0.75.1');
    expect(button).toBeDisabled();

    await user.clear(input);
    await user.type(input, 'v0.75.0');
    await waitFor(() => {
      expect(button).toBeEnabled();
    });
  });

  it('sends the confirmed target and switches to the in-progress view', async () => {
    const user = userEvent.setup();
    renderWithIntl(<UpdatePage />);

    const input = await screen.findByLabelText(/target version/i);
    await user.type(input, 'v0.75.0');
    await user.click(screen.getByRole('button', { name: /update to v0\.75\.0/i }));

    await waitFor(() => {
      expect(mockTriggerUpdate).toHaveBeenCalledWith({
        targetVersion: 'v0.75.0',
        confirm: 'v0.75.0',
      });
    });
    expect(await screen.findByText(/update in progress/i)).toBeInTheDocument();
  });

  it('renders a refused trigger with its own message, not a raw error', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('../../../_lib/api');
    mockTriggerUpdate.mockRejectedValue(
      new (ApiError as new (s: number, m: string, b?: string) => Error)(
        409,
        'POST failed',
        JSON.stringify({ error: 'update_in_progress' }),
      ),
    );
    renderWithIntl(<UpdatePage />);

    const input = await screen.findByLabelText(/target version/i);
    await user.type(input, 'v0.75.0');
    await user.click(screen.getByRole('button', { name: /update to v0\.75\.0/i }));

    expect(
      await screen.findByText(/an update is already running/i),
    ).toBeInTheDocument();
  });

  it('refuses to offer an update that could not be recorded', async () => {
    mockGetUpdateStatus.mockResolvedValue(status({ auditAvailable: false }));
    mockGetUpdateHistory.mockResolvedValue({ entries: [], available: false });
    renderWithIntl(<UpdatePage />);

    await waitFor(() => {
      expect(screen.getByText(/no Postgres is connected/i)).toBeInTheDocument();
    });
    const button = screen.getByRole('button', { name: /update to v0\.75\.0/i });
    expect(button).toBeDisabled();
  });

  it('reports an up-to-date instance without a confirm box', async () => {
    mockGetUpdateStatus.mockResolvedValue(
      status({
        current: { version: 'v0.75.0', source: 'release' },
        updateAvailable: false,
      }),
    );
    renderWithIntl(<UpdatePage />);

    await waitFor(() => {
      expect(screen.getByText(/running the latest release/i)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/target version/i)).not.toBeInTheDocument();
  });

  it('warns that the release check is stale rather than presenting it as fact', async () => {
    mockGetUpdateStatus.mockResolvedValue(
      status({ check: { checkedAt: 1, stale: true, error: 'ENOTFOUND' } }),
    );
    renderWithIntl(<UpdatePage />);

    await waitFor(() => {
      expect(screen.getByText(/could not reach GitHub/i)).toBeInTheDocument();
    });
  });

  it('shows the audit trail when there is one', async () => {
    mockGetUpdateHistory.mockResolvedValue({
      available: true,
      entries: [
        {
          id: 'a1',
          actor: 'operator@example.com',
          fromVersion: 'v0.73.0',
          toVersion: 'v0.74.0',
          outcome: 'succeeded',
          detail: null,
          createdAt: '2026-08-12T10:00:00Z',
        },
      ],
    });
    renderWithIntl(<UpdatePage />);

    await waitFor(() => {
      expect(screen.getByText('v0.73.0 → v0.74.0')).toBeInTheDocument();
    });
    expect(screen.getByText('operator@example.com')).toBeInTheDocument();
  });
});
