import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import MemoryDetailPage from '../page';

/**
 * Issue #1859 — the load error of the memory detail page.
 *
 * `GET /v1/memory/:id` answers 404 with `{"code":"memory.not_found"}` both for
 * an unknown id and for an entry the caller does not own. The page has its own
 * text for that case; every other failure keeps the generic error line.
 */

const MEMORY_ID = 'mk:00000000-0000-4000-8000-000000000000';
const MEMORY_PATH = `/v1/memory/${encodeURIComponent(MEMORY_ID)}`;

const { mockGetMemory } = vi.hoisted(() => ({ mockGetMemory: vi.fn() }));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: encodeURIComponent(MEMORY_ID) }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// Keep the real ApiError (its `code` comes from the JSON body); stub the calls.
vi.mock('../../../_lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/api')>()),
  getMemory: mockGetMemory,
  getMemoryAudit: vi.fn(() => Promise.resolve({ items: [] })),
  getMemoryExcerpts: vi.fn(() => Promise.resolve({ items: [] })),
}));

describe('MemoryDetailPage load error', () => {
  beforeEach(() => {
    mockGetMemory.mockReset();
  });

  it('shows the not-found text for a 404 with code memory.not_found', async () => {
    mockGetMemory.mockRejectedValue(
      new ApiError(404, `GET ${MEMORY_PATH} failed: 404`, '{"code":"memory.not_found"}'),
    );

    renderWithIntl(<MemoryDetailPage />);

    expect(
      await screen.findByText('Memory not found or you are not an owner.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/failed: 404/)).not.toBeInTheDocument();
  });

  it('keeps the generic error line for any other failure', async () => {
    mockGetMemory.mockRejectedValue(
      new ApiError(500, `GET ${MEMORY_PATH} failed: 500`, '{"code":"memory.internal"}'),
    );

    renderWithIntl(<MemoryDetailPage />);

    expect(await screen.findByText(/failed: 500/)).toBeInTheDocument();
    expect(
      screen.queryByText('Memory not found or you are not an owner.'),
    ).not.toBeInTheDocument();
  });
});
