import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import { initDiagnosticsCapture } from '../../_lib/diagnosticsBuffer';
import { CreateIssueButton } from '../CreateIssueButton';

/**
 * Mocks the API client, not the diagnostics ring buffer — CreateIssueButton
 * imports `formatDiagnosticsExcerpt`/`hasDiagnostics`/`initDiagnosticsCapture`
 * from the real module, which is what lets these tests simulate the buffer
 * changing between the /preview and /create calls (issue #433 review).
 * Diagnostics entries are seeded via real `window` `error` events, not a
 * direct buffer-write helper — the buffer only ever captures window
 * error/unhandledrejection events, never individual failed API calls (see
 * the #433 review narrowed-scope fix in diagnosticsBuffer.ts/api.ts).
 */
function seedWindowError(message: string): void {
  initDiagnosticsCapture();
  window.dispatchEvent(new ErrorEvent('error', { message }));
}
const { mockPreview, mockCreate, mockStatus } = vi.hoisted(() => ({
  mockPreview: vi.fn(),
  mockCreate: vi.fn(),
  mockStatus: vi.fn(),
}));

vi.mock('../../_lib/api', () => {
  class ApiError extends Error {
    status: number;
    body: string;
    constructor(status: number, message: string, body = '') {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
  }
  return {
    ApiError,
    previewGithubIssue: mockPreview,
    createGithubIssue: mockCreate,
    getGithubIssueStatus: mockStatus,
    disconnectGithub: vi.fn(),
    pollGithubConnect: vi.fn(),
    startGithubConnect: vi.fn(),
  };
});

async function openDialog(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'Create issue' }));
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(mockStatus).toHaveBeenCalled());
  return dialog;
}

describe('<CreateIssueButton /> diagnostics (#433 review)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends the exact preview-time diagnostics snapshot to /create, unaffected by later buffer changes', async () => {
    seedWindowError('seed-error-before-preview');
    mockStatus.mockResolvedValue({ connected: true, login: 'op', oauthConfigured: true });
    mockPreview.mockResolvedValue({
      title: 'A bug',
      body: 'Body text',
      category: 'bug',
      diagnostics: '<details>seeded</details>',
    });
    mockCreate.mockResolvedValue({ number: 1, htmlUrl: 'https://github.com/x/y/issues/1' });

    renderWithIntl(<CreateIssueButton />);
    const dialog = await openDialog();

    fireEvent.change(within(dialog).getByPlaceholderText(/What happened/i), {
      target: { value: 'Something broke' },
    });
    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: /Attach recent errors/i }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(1));
    const previewDiagnostics = mockPreview.mock.calls[0]![0].diagnostics as string;
    expect(previewDiagnostics).toContain('seed-error-before-preview');

    // Simulate an unrelated error elsewhere in the app while the operator is
    // still looking at the preview screen — the live buffer now differs from
    // what /preview sanitized and echoed back.
    seedWindowError('drift-error-during-preview');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create issue' }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    const createDiagnostics = mockCreate.mock.calls[0]![0].diagnostics as string;

    expect(createDiagnostics).toBe(previewDiagnostics);
    expect(createDiagnostics).toContain('seed-error-before-preview');
    expect(createDiagnostics).not.toContain('drift-error-during-preview');
  });

  it('shows a specific message when /preview rejects invalid_diagnostics', async () => {
    mockStatus.mockResolvedValue({ connected: true, login: 'op', oauthConfigured: true });
    const { ApiError } = (await import('../../_lib/api')) as unknown as {
      ApiError: new (status: number, message: string, body?: string) => Error;
    };
    mockPreview.mockRejectedValue(
      new ApiError(400, 'POST /v1/issues/preview failed: 400', '{"code":"invalid_diagnostics"}'),
    );

    renderWithIntl(<CreateIssueButton />);
    const dialog = await openDialog();

    fireEvent.change(within(dialog).getByPlaceholderText(/What happened/i), {
      target: { value: 'Something broke' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));

    expect(
      await within(dialog).findByText(/attached diagnostics excerpt was rejected/i),
    ).toBeInTheDocument();
  });

  it('shows a specific message when /create rejects invalid_diagnostics', async () => {
    mockStatus.mockResolvedValue({ connected: true, login: 'op', oauthConfigured: true });
    mockPreview.mockResolvedValue({ title: 'A bug', body: 'Body text', category: 'bug' });
    const { ApiError } = (await import('../../_lib/api')) as unknown as {
      ApiError: new (status: number, message: string, body?: string) => Error;
    };
    mockCreate.mockRejectedValue(
      new ApiError(400, 'POST /v1/issues/create failed: 400', '{"code":"invalid_diagnostics"}'),
    );

    renderWithIntl(<CreateIssueButton />);
    const dialog = await openDialog();

    fireEvent.change(within(dialog).getByPlaceholderText(/What happened/i), {
      target: { value: 'Something broke' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(1));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create issue' }));

    expect(
      await within(dialog).findByText(/attached diagnostics excerpt was rejected/i),
    ).toBeInTheDocument();
  });
});
