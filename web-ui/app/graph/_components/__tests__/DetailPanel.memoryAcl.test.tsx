import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import DetailPanel from '../DetailPanel';
import type { GraphNode } from '../graphTypes';

/**
 * Issue #1854 — selecting another memory kept the previous entry's audit
 * list and the typed owner/reason text, because the owner section was not
 * keyed by the entry.
 */

function memory(id: string): GraphNode {
  return {
    id,
    type: 'MemorableKnowledge',
    props: { summary: id, acl_owners: ['u1'] },
  };
}

const fetchMock = vi.fn((url: string) =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        items: [
          {
            id: `audit-${url}`,
            memoryExternalId: url,
            actorOmadiaUserId: 'u1',
            action: url.includes('mk%3Aa') ? 'edit' : 'create',
            beforeOwners: ['u1'],
            afterOwners: ['u1'],
            reason: url.includes('mk%3Aa') ? 'reason of A' : undefined,
            createdAt: '2026-11-26T10:00:00Z',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  ),
);

function panel(node: GraphNode): React.ReactElement {
  return (
    <DetailPanel
      node={node}
      onSelect={() => undefined}
      onExpand={() => undefined}
      onClose={() => undefined}
      loadingNeighbors={false}
    />
  );
}

describe('DetailPanel memory owner section (#1854)', () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the selected entry’s own audit and empty inputs after a switch', async () => {
    const view = renderWithIntl(panel(memory('mk:a')));
    fireEvent.change(screen.getByPlaceholderText(/omadiaUserId/), {
      target: { value: 'typed-for-a' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Audit' }));
    expect(await screen.findByText(/reason of A/)).toBeInTheDocument();

    view.rerender(panel(memory('mk:b')));

    // A fresh section: back on the owners tab, inputs empty.
    expect(screen.getByPlaceholderText(/omadiaUserId/)).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Audit' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/bot-api/v1/memory/${encodeURIComponent('mk:b')}/audit`,
      );
    });
    await waitFor(() => {
      expect(screen.queryByText(/reason of A/)).not.toBeInTheDocument();
    });
  });
});
