import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type MemoryPurgePreviewResult } from '../../../_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import DangerZonePage from '../page';

/**
 * Danger Zone memory purge (#1333, #1334, #1335): the page shows why a preview
 * failed, translates server warnings, counts the conversation history, never
 * offers a delete for an empty preview, re-previews when the re-seed toggle
 * changes and sends the preview's token with the delete.
 */

const { mockPreview, mockPurge } = vi.hoisted(() => ({
  mockPreview: vi.fn(),
  mockPurge: vi.fn(),
}));

// Keep the real ApiError (its `code` / `serverMessage` come from the body).
vi.mock('../../../_lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../_lib/api')>();
  return { ...actual, previewMemoryPurge: mockPreview, purgeMemory: mockPurge };
});

afterEach(() => {
  vi.clearAllMocks();
});

function previewResult(over: Partial<MemoryPurgePreviewResult> = {}): MemoryPurgePreviewResult {
  return {
    scratchCount: 2,
    kgCount: 1,
    conversationCount: 17,
    reseedEntries: [],
    warnings: [],
    previewToken: 'tok-1',
    previewExpiresAt: '2026-10-16T10:10:00Z',
    ...over,
  };
}

function chooseAxis(axis: string): void {
  fireEvent.change(screen.getByRole('combobox'), { target: { value: axis } });
}

function typeSelector(value: string): void {
  fireEvent.change(screen.getByPlaceholderText(/teams~AAD-OBJECT-ID|teams~19:abc|telegram~|de\.byte5/), {
    target: { value },
  });
}

describe('<DangerZonePage />', () => {
  it('shows the translated reason for an invalid selector, not the bare status line', async () => {
    mockPreview.mockRejectedValue(
      new ApiError(
        400,
        'POST /v1/admin/memory/purge/preview failed: 400',
        JSON.stringify({ error: 'invalid_selector', message: 'raw server text' }),
      ),
    );
    renderWithIntl(<DangerZonePage />);
    chooseAxis('user');
    typeSelector('Tom123');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(await screen.findByText(/The selector must be spelled channelType~id/)).toBeInTheDocument();
    expect(screen.queryByText(/failed: 400/)).toBeNull();
  });

  it("falls back to the server's message for a code without copy", async () => {
    mockPreview.mockRejectedValue(
      new ApiError(400, 'POST x failed: 400', JSON.stringify({ error: 'tenant_mismatch', message: 'tenant is not bound' })),
    );
    renderWithIntl(<DangerZonePage />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(await screen.findByText('Preview error: tenant is not bound')).toBeInTheDocument();
  });

  it('renders the selector hint with code, not literal backticks', () => {
    renderWithIntl(<DangerZonePage />);
    chooseAxis('team');

    expect(screen.queryByText(/`/)).toBeNull();
    expect(screen.getAllByText('channelType~id').some((el) => el.tagName === 'CODE')).toBe(true);
  });

  it('translates a warning code and offers no delete when nothing matched', async () => {
    mockPreview.mockResolvedValue(
      previewResult({
        scratchCount: 0,
        kgCount: 0,
        conversationCount: 0,
        warnings: [{ code: 'kg_not_modelled', params: { axis: 'channel' } }],
      }),
    );
    renderWithIntl(<DangerZonePage />);
    chooseAxis('channel');
    typeSelector('teams~tom123');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(await screen.findByText(/no channel scoping yet/)).toBeInTheDocument();
    expect(screen.getByText(/found nothing to delete/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete irreversibly' })).toBeNull();
  });

  it('counts the conversation history and sends the preview token with the delete', async () => {
    mockPreview.mockResolvedValue(previewResult());
    mockPurge.mockResolvedValue({ scratchDeleted: 2, kgDeleted: 1, conversationDeleted: 17, warnings: [] });
    renderWithIntl(<DangerZonePage />);
    chooseAxis('agent');
    typeSelector('fallback');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(await screen.findByText('Conversation history (knowledge graph)')).toBeInTheDocument();
    expect(screen.getByText('17')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('fallback'), { target: { value: 'fallback' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete irreversibly' }));

    await waitFor(() => {
      expect(mockPurge).toHaveBeenCalledWith({
        axis: 'agent',
        selector: 'fallback',
        confirm: 'fallback',
        previewToken: 'tok-1',
      });
    });
  });

  it('toggling the re-seed drops the preview and the next preview asks for it', async () => {
    mockPreview.mockResolvedValue(previewResult());
    renderWithIntl(<DangerZonePage />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByPlaceholderText('DELETE ALL MEMORY')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.queryByPlaceholderText('DELETE ALL MEMORY')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => {
      expect(mockPreview).toHaveBeenLastCalledWith({ axis: 'all', reseed: true });
    });
  });
});
