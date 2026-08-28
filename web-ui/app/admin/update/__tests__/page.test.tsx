import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { UpdateClient } from '../_components/UpdateClient';

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
  window.localStorage.clear();
});

const INFLIGHT_KEY = 'omadia.adminUpdate.inflight';

describe('/admin/update', () => {
  it('reports the running version and that a newer release exists', async () => {
    renderWithIntl(<UpdateClient />);

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
    renderWithIntl(<UpdateClient />);

    await waitFor(() => {
      expect(screen.getByText(/build not stamped/i)).toBeInTheDocument();
    });
  });

  it('offers the manual command instead of a button when no updater is configured', async () => {
    mockGetUpdateStatus.mockResolvedValue(
      status({ executor: { configured: false, reachable: false } }),
    );
    renderWithIntl(<UpdateClient />);

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

  it('labels the manual commands per platform and offers the Fly one too', async () => {
    // The executor is compose-only, so Fly.io and Kubernetes deployments land
    // in exactly this state — an unlabelled `docker compose` line would be
    // actively misleading there.
    mockGetUpdateStatus.mockResolvedValue(
      status({ executor: { configured: false, reachable: false } }),
    );
    renderWithIntl(<UpdateClient />);

    await waitFor(() => {
      expect(screen.getByText('Docker Compose')).toBeInTheDocument();
    });
    expect(screen.getByText('Fly.io')).toBeInTheDocument();
    expect(
      screen.getByText(/ghcr\.io\/byte5ai\/omadia-middleware:v0\.75\.0/),
    ).toBeInTheDocument();
    expect(screen.getByText(/docs\/upgrading\.md/)).toBeInTheDocument();
  });

  it('fills the Fly command in with the real app names when running on Fly', async () => {
    mockGetUpdateStatus.mockResolvedValue(
      status({
        executor: { configured: false, reachable: false },
        platform: {
          kind: 'fly',
          appName: 'omadia-middleware-a1b2c3',
          machineId: '148e392a7e1234',
        },
      }),
    );
    renderWithIntl(<UpdateClient webUiApp="omadia-web-ui-a1b2c3" />);

    const block = await screen.findByText(/fly deploy --app omadia-middleware-a1b2c3/);
    const command = block.textContent ?? '';

    expect(command).toContain('--app omadia-web-ui-a1b2c3');
    expect(command).not.toContain('<middleware-app>');
    expect(command).not.toContain('<web-ui-app>');
    // Middleware before web-ui: it applies the schema migrations at boot.
    expect(command.indexOf('omadia-middleware-a1b2c3')).toBeLessThan(
      command.indexOf('omadia-web-ui-a1b2c3'),
    );
    expect(screen.getByText(/in order/i)).toBeInTheDocument();
    expect(screen.getByText(/image line in your fly\.toml/i)).toBeInTheDocument();
  });

  it('keeps the placeholders, and drops the Fly-only hints, off Fly', async () => {
    mockGetUpdateStatus.mockResolvedValue(
      status({
        executor: { configured: false, reachable: false },
        platform: { kind: 'unknown' },
      }),
    );
    renderWithIntl(<UpdateClient />);

    const block = await screen.findByText(/fly deploy --app <middleware-app>/);
    expect(block.textContent ?? '').toContain('<web-ui-app>');
    expect(screen.queryByText(/image line in your fly\.toml/i)).not.toBeInTheDocument();
  });

  it('survives a middleware that does not report a platform at all', async () => {
    // An older middleware behind a newer UI: `platform` is simply absent.
    mockGetUpdateStatus.mockResolvedValue(
      status({ executor: { configured: false, reachable: false }, platform: undefined }),
    );
    renderWithIntl(<UpdateClient webUiApp="omadia-web-ui-a1b2c3" />);

    const block = await screen.findByText(/fly deploy --app <middleware-app>/);
    // The half we DO know is still filled in.
    expect(block.textContent ?? '').toContain('--app omadia-web-ui-a1b2c3');
  });

  it('says so when the updater is configured but unreachable', async () => {
    mockGetUpdateStatus.mockResolvedValue(
      status({
        executor: { configured: true, reachable: false, error: 'ECONNREFUSED' },
      }),
    );
    renderWithIntl(<UpdateClient />);

    await waitFor(() => {
      expect(screen.getByText(/did not answer/i)).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('button', { name: /update to/i }),
    ).not.toBeInTheDocument();
  });

  it('keeps the trigger disabled until the target version is retyped exactly', async () => {
    const user = userEvent.setup();
    renderWithIntl(<UpdateClient />);

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
    renderWithIntl(<UpdateClient />);

    const input = await screen.findByLabelText(/target version/i);
    await user.type(input, 'v0.75.0');
    await user.click(screen.getByRole('button', { name: /update to v0\.75\.0/i }));

    await waitFor(() => {
      expect(mockTriggerUpdate).toHaveBeenCalledWith({
        targetVersion: 'v0.75.0',
        confirm: 'v0.75.0',
      });
    });
    // The page is covered by the progress dialog, not decorated with a box.
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('data-outcome', 'running');
    expect(screen.getByRole('heading', { name: /updating to v0\.75\.0/i })).toBeInTheDocument();
    expect(screen.getByTestId('polling-indicator')).toBeInTheDocument();
    // The dialog cannot be dismissed while running.
    expect(screen.queryByRole('button', { name: /^close$/i })).not.toBeInTheDocument();
    // And the run is remembered, so a reload of the (replaced) admin UI resumes it.
    const remembered = JSON.parse(window.localStorage.getItem(INFLIGHT_KEY) ?? 'null') as
      | { target: string; previous: string | null }
      | null;
    expect(remembered).toMatchObject({ target: 'v0.75.0', previous: 'v0.74.0' });
  });

  it('resumes the dialog after a reload from the remembered run', async () => {
    window.localStorage.setItem(
      INFLIGHT_KEY,
      JSON.stringify({ target: 'v0.75.0', previous: 'v0.74.0', startedAt: Date.now() }),
    );
    mockGetUpdateStatus.mockResolvedValue(
      status({
        executor: {
          configured: true, reachable: true, state: 'updating', targetVersion: 'v0.75.0',
          startedAt: new Date().toISOString(), phase: 'health_gate', steps: ['leased', 'waiting'],
        },
      }),
    );
    renderWithIntl(<UpdateClient />);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('data-outcome', 'running');
    // The stepper follows the sidecar's phase, not the text trail.
    await waitFor(() => {
      expect(dialog.querySelector('[data-step="health_gate"]')).toHaveAttribute('data-state', 'current');
    });
    expect(dialog.querySelector('[data-step="replace"]')).toHaveAttribute('data-state', 'done');
  });

  it('adopts an update started from somewhere else', async () => {
    mockGetUpdateStatus.mockResolvedValue(
      status({
        executor: {
          configured: true, reachable: true, state: 'updating', targetVersion: 'v0.75.0',
          previousVersion: 'v0.74.0', startedAt: new Date().toISOString(), phase: 'replace', steps: [],
        },
      }),
    );
    renderWithIntl(<UpdateClient />);
    expect(await screen.findByRole('dialog')).toHaveAttribute('data-outcome', 'running');
  });

  it('shows the middleware as not answering — not as an error — while it restarts', async () => {
    window.localStorage.setItem(
      INFLIGHT_KEY,
      JSON.stringify({ target: 'v0.75.0', previous: 'v0.74.0', startedAt: Date.now() }),
    );
    mockGetUpdateStatus.mockRejectedValue(new Error('fetch failed'));
    renderWithIntl(<UpdateClient />);

    const indicator = await screen.findByTestId('polling-indicator');
    await waitFor(() => {
      expect(indicator).toHaveAttribute('data-reachable', 'false');
    });
    expect(screen.getByText(/not answering/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not load the update status/i)).not.toBeInTheDocument();
  });

  it('turns into the success view once the middleware reports the target', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      INFLIGHT_KEY,
      JSON.stringify({ target: 'v0.75.0', previous: 'v0.74.0', startedAt: Date.now() }),
    );
    mockGetUpdateStatus.mockResolvedValue(
      status({
        current: { version: 'v0.75.0', source: 'release' },
        updateAvailable: false,
        executor: { configured: true, reachable: true, state: 'succeeded', targetVersion: 'v0.75.0', phase: 'done', steps: [] },
      }),
    );
    renderWithIntl(<UpdateClient />);

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(dialog).toHaveAttribute('data-outcome', 'succeeded');
    });
    expect(screen.getByRole('heading', { name: /updated to v0\.75\.0/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload admin ui/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^close$/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(window.localStorage.getItem(INFLIGHT_KEY)).toBeNull();
  });

  it('explains a health-gate rollback with the likely cause instead of a raw error string', async () => {
    window.localStorage.setItem(
      INFLIGHT_KEY,
      JSON.stringify({ target: 'v0.120.0', previous: 'v0.90.1', startedAt: Date.now() - 6 * 60_000 }),
    );
    mockGetUpdateStatus.mockResolvedValue(
      status({
        current: { version: 'v0.90.1', source: 'release' },
        latest: { tag: 'v0.120.0', url: 'https://example.test', publishedAt: '2026-08-21T09:00:00Z', prerelease: false },
        executor: {
          configured: true, reachable: true, state: 'rolled_back', targetVersion: 'v0.120.0',
          previousVersion: 'v0.90.1', startedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
          finishedAt: new Date().toISOString(), phase: 'rollback',
          error: 'health gate failed: never_reachable (observed version: none)',
          failure: { kind: 'health_gate', reason: 'never_reachable', observedVersion: null },
          steps: ['waiting for http://middleware:8080/health to report v0.120.0', 'health gate failed: never_reachable (observed version: none)', 'rolling back'],
        },
      }),
    );
    renderWithIntl(<UpdateClient />);

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(dialog).toHaveAttribute('data-outcome', 'rolled_back');
    });
    expect(screen.getByRole('heading', { name: /update to v0\.120\.0 rolled back/i })).toBeInTheDocument();
    const explanation = screen.getByTestId('failure-explanation');
    expect(explanation).toHaveAttribute('data-failure-kind', 'never_reachable');
    expect(explanation).toHaveTextContent(/never answered \/health/i);
    expect(explanation).toHaveTextContent(/CREDENTIAL_KEYCHAIN_KEY/);
    expect(dialog.querySelector('[data-step="health_gate"]')).toHaveAttribute('data-state', 'failed');
    expect(dialog.querySelector('[data-step="rollback"]')).toHaveAttribute('data-state', 'done');
    expect(screen.getByRole('link', { name: /docs\/upgrading\.md/i })).toHaveAttribute(
      'href',
      expect.stringContaining('docs/upgrading.md'),
    );
  });

  it('stays closed after the operator dismisses a stalled run, even while the sidecar still says updating', async () => {
    const user = userEvent.setup();
    // A run remembered from 20 minutes ago — past the stall threshold.
    const startedAt = Date.now() - 20 * 60_000;
    window.localStorage.setItem(
      INFLIGHT_KEY,
      JSON.stringify({ target: 'v0.75.0', previous: 'v0.74.0', startedAt }),
    );
    mockGetUpdateStatus.mockResolvedValue(
      status({
        executor: {
          configured: true, reachable: true, state: 'updating', targetVersion: 'v0.75.0',
          previousVersion: 'v0.74.0', startedAt: new Date(startedAt).toISOString(), phase: 'health_gate', steps: [],
        },
      }),
    );
    renderWithIntl(<UpdateClient />);

    const dismiss = await screen.findByRole('button', { name: /^dismiss$/i });
    await user.click(dismiss);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    // Polls keep returning the same `updating` snapshot; adoption must not reopen it.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(INFLIGHT_KEY)).toBeNull();
  });

  it('drops a remembered run that is older than the TTL instead of resuming it', async () => {
    window.localStorage.setItem(
      INFLIGHT_KEY,
      JSON.stringify({ target: 'v0.75.0', previous: 'v0.74.0', startedAt: Date.now() - 2 * 60 * 60_000 }),
    );
    renderWithIntl(<UpdateClient />);
    await screen.findByText('v0.74.0');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(INFLIGHT_KEY)).toBeNull();
  });

  it('does not let a rollback from an EARLIER run close a freshly started one', async () => {
    const user = userEvent.setup();
    // The sidecar still reports last week's rollback for the same target.
    mockGetUpdateStatus.mockResolvedValue(
      status({
        executor: {
          configured: true, reachable: true, state: 'rolled_back', targetVersion: 'v0.75.0',
          startedAt: '2026-08-01T00:00:00Z', finishedAt: '2026-08-01T00:06:00Z',
          failure: { kind: 'health_gate', reason: 'never_reachable', observedVersion: null },
          error: 'health gate failed', steps: [],
        },
      }),
    );
    renderWithIntl(<UpdateClient />);

    // Before the click: the decoded banner, not the dialog.
    expect(await screen.findByTestId('rolled-back-banner')).toHaveTextContent(/never answered \/health/i);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const input = screen.getByLabelText(/target version/i);
    await user.type(input, 'v0.75.0');
    await user.click(screen.getByRole('button', { name: /update to v0\.75\.0/i }));

    const dialog = await screen.findByRole('dialog');
    // Polls keep returning the OLD rolled_back status; the dialog must stay open.
    await new Promise((r) => setTimeout(r, 50));
    expect(dialog).toHaveAttribute('data-outcome', 'running');
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
    renderWithIntl(<UpdateClient />);

    const input = await screen.findByLabelText(/target version/i);
    await user.type(input, 'v0.75.0');
    await user.click(screen.getByRole('button', { name: /update to v0\.75\.0/i }));

    expect(
      await screen.findByText(/an update is already running/i),
    ).toBeInTheDocument();
  });

  it('warns that the Fly executor cannot make the version stick', async () => {
    // The updater moves the machines but cannot write the pin — `fly deploy`
    // reads the operator's local fly.toml. Saying so is the difference between
    // an informed click and a surprise revert on the next routine deploy.
    mockGetUpdateStatus.mockResolvedValue(
      status({
        executor: {
          configured: true,
          reachable: true,
          state: 'idle',
          steps: [],
          engine: 'fly',
          pinPersisted: false,
        },
      }),
    );
    renderWithIntl(<UpdateClient />);

    expect(await screen.findByText(/cannot make the version stick/i)).toBeInTheDocument();
    // Still offered — this is a caveat, not a blocker.
    expect(
      screen.getByRole('button', { name: /update to v0\.75\.0/i }),
    ).toBeInTheDocument();
  });

  it('stays quiet about the pin on an executor that does persist it', async () => {
    mockGetUpdateStatus.mockResolvedValue(
      status({
        executor: {
          configured: true,
          reachable: true,
          state: 'idle',
          steps: [],
          engine: 'docker',
          pinPersisted: true,
        },
      }),
    );
    renderWithIntl(<UpdateClient />);

    await waitFor(() => {
      expect(screen.getByLabelText(/target version/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/cannot make the version stick/i)).not.toBeInTheDocument();
  });

  it('refuses to offer an update that could not be recorded', async () => {
    mockGetUpdateStatus.mockResolvedValue(status({ auditAvailable: false }));
    mockGetUpdateHistory.mockResolvedValue({ entries: [], available: false });
    renderWithIntl(<UpdateClient />);

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
    renderWithIntl(<UpdateClient />);

    await waitFor(() => {
      expect(screen.getByText(/running the latest release/i)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/target version/i)).not.toBeInTheDocument();
  });

  it('warns that the release check is stale rather than presenting it as fact', async () => {
    mockGetUpdateStatus.mockResolvedValue(
      status({ check: { checkedAt: 1, stale: true, error: 'ENOTFOUND' } }),
    );
    renderWithIntl(<UpdateClient />);

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
    renderWithIntl(<UpdateClient />);

    await waitFor(() => {
      expect(screen.getByText('v0.73.0 → v0.74.0')).toBeInTheDocument();
    });
    expect(screen.getByText('operator@example.com')).toBeInTheDocument();
  });
});
