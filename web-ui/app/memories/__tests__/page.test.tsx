import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type MemorableKnowledgeNode } from '../../_lib/api';
import { renderWithIntl } from '../../_lib/test-utils';
import MemoriesPage from '../page';

/**
 * Issue #1853 — `/memories` stopped at the first 50 entries without a hint.
 * The list now pages with the server's `nextCursor` behind "Load more".
 */

const { mockListMemories } = vi.hoisted(() => ({ mockListMemories: vi.fn() }));

vi.mock('../../_lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../_lib/api')>()),
  listMemories: mockListMemories,
}));

function mk(n: number): MemorableKnowledgeNode {
  return {
    id: `mk:entry-${String(n)}`,
    type: 'MemorableKnowledge',
    props: {
      kind: 'reference',
      summary: `Cap test entry ${String(n)}`,
      acl_owners: ['u1'],
      created_at: '2026-11-26T10:00:00Z',
      created_by: 'web:u1',
    },
  } as MemorableKnowledgeNode;
}

describe('MemoriesPage paging (#1853)', () => {
  beforeEach(() => {
    mockListMemories.mockReset();
  });

  it('loads the next page with the cursor and appends it', async () => {
    mockListMemories
      .mockResolvedValueOnce({ items: [mk(2)], nextCursor: '1' })
      .mockResolvedValueOnce({ items: [mk(1)], nextCursor: null });

    renderWithIntl(<MemoriesPage />);

    expect(await screen.findByText('Cap test entry 2')).toBeInTheDocument();
    expect(screen.getByText(/more are available/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Cap test entry 1')).toBeInTheDocument();
    expect(mockListMemories).toHaveBeenLastCalledWith({ cursor: '1' });
    expect(screen.getByText('Cap test entry 2')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Load more' }),
    ).not.toBeInTheDocument();
  });

  it('offers no "Load more" on the last page', async () => {
    mockListMemories.mockResolvedValueOnce({ items: [mk(1)], nextCursor: null });

    renderWithIntl(<MemoriesPage />);

    expect(await screen.findByText('Cap test entry 1')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Load more' }),
    ).not.toBeInTheDocument();
  });

  it('shows a localized headline and the server message, never the transport line', async () => {
    mockListMemories
      .mockResolvedValueOnce({ items: [mk(2)], nextCursor: '1' })
      .mockRejectedValueOnce(
        new ApiError(503, 'GET memory failed: 503', '{"code":"kg.unavailable","message":"graph offline"}'),
      );

    renderWithIntl(<MemoriesPage />);
    expect(await screen.findByText('Cap test entry 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Could not load more memories.')).toBeInTheDocument();
    expect(screen.getByText('(graph offline)')).toBeInTheDocument();
    expect(screen.queryByText(/GET memory failed/)).not.toBeInTheDocument();
  });
});
