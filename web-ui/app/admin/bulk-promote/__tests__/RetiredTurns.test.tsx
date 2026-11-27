import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { ApiError } from '../../../_lib/api';
import { RetiredTurns } from '../_components/RetiredTurns';

const { mockList, mockUnretire } = vi.hoisted(() => ({ mockList: vi.fn(), mockUnretire: vi.fn() }));

vi.mock('../../../_lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/api')>()),
  listRetiredTurns: mockList,
  unretireTurn: mockUnretire,
}));

beforeEach(() => {
  mockList.mockReset();
  mockUnretire.mockReset();
  mockList.mockResolvedValue([
    { turnId: 'turn:a', reason: 'memory_deleted', retiredAt: '2026-11-12T00:00:00.000Z', agentSlug: 'desk' },
    { turnId: 'turn:k', reason: 'no_person_owner', retiredAt: '2026-11-12T00:00:00.000Z' },
  ]);
  mockUnretire.mockResolvedValue(undefined);
});

describe('RetiredTurns (#2295)', () => {
  it('offers "allow again" only for turns a person owns', async () => {
    renderWithIntl(<RetiredTurns />);
    await screen.findByText('turn:a');
    expect(screen.getAllByRole('button', { name: /Allow turn/i })).toHaveLength(1);
    expect(screen.getByText(/No person owns it/)).toBeInTheDocument();
  });

  it('allows a turn again and removes it from the list', async () => {
    const user = userEvent.setup();
    renderWithIntl(<RetiredTurns />);
    await user.click(await screen.findByRole('button', { name: /Allow turn turn:a/i }));
    await waitFor(() => expect(mockUnretire).toHaveBeenCalledWith('turn:a'));
    await waitFor(() => expect(screen.queryByText('turn:a')).not.toBeInTheDocument());
  });

  it('shows a localized error for a refused change', async () => {
    const user = userEvent.setup();
    mockUnretire.mockRejectedValue(
      new ApiError(500, 'POST failed', JSON.stringify({ code: 'audit_write_failed' })),
    );
    renderWithIntl(<RetiredTurns />);
    await user.click(await screen.findByRole('button', { name: /Allow turn turn:a/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/audit log/i);
  });
});
