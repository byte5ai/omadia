import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import MemoryDetailPage from '../page';

/**
 * Issue #1853 — an excerpt deletion (`delete_excerpt`, written when a
 * duplicate excerpt is resolved) showed the key path
 * `memories.detail.actions.undefined` in the history.
 */

const MEMORY_ID = 'mk:00000000-0000-4000-8000-000000000001';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: encodeURIComponent(MEMORY_ID) }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('../../../_lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/api')>()),
  getMemory: vi.fn(() =>
    Promise.resolve({
      id: MEMORY_ID,
      type: 'MemorableKnowledge',
      props: {
        kind: 'reference',
        summary: 'Owner check probe.',
        acl_owners: ['u1'],
        created_at: '2026-11-26T10:00:00Z',
        created_by: 'web:u1',
      },
    }),
  ),
  getMemoryAudit: vi.fn(() =>
    Promise.resolve({
      items: [
        {
          id: 'a1',
          memoryExternalId: MEMORY_ID,
          actorOmadiaUserId: 'u1',
          action: 'delete_excerpt',
          beforeOwners: ['u1'],
          afterOwners: ['u1'],
          createdAt: '2026-11-26T10:05:00Z',
        },
      ],
    }),
  ),
  getMemoryExcerpts: vi.fn(() => Promise.resolve({ items: [] })),
}));

describe('MemoryDetailPage history labels (#1853)', () => {
  it('labels an excerpt deletion', async () => {
    renderWithIntl(<MemoryDetailPage />);
    expect(await screen.findByText('excerpt deleted')).toBeInTheDocument();
    expect(screen.queryByText(/actions\.undefined/)).not.toBeInTheDocument();
  });
});
