import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type OwnerlessMemory } from '../../../_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import { OwnerlessMemoriesPanel } from '../OwnerlessMemoriesPanel';

/** ADR-0185 (#1829, #1831) — the operator deletes owner-less memories one by one. */

const { mockList, mockDelete } = vi.hoisted(() => ({ mockList: vi.fn(), mockDelete: vi.fn() }));

vi.mock('../../../_lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../_lib/api')>();
  return { ...actual, listOwnerlessMemories: mockList, deleteOwnerlessMemory: mockDelete };
});

afterEach(() => {
  vi.clearAllMocks();
});

const RULE: OwnerlessMemory = {
  id: 'mk:1',
  kind: 'reference',
  summary: 'Wenn jemand nach dem Wetter fragt: Sonnig',
  createdBy: 'system:rules-hook',
  originAgent: null,
  createdAt: '2026-11-20T09:00:00.000Z',
  isRule: true,
};

describe('<OwnerlessMemoriesPanel />', () => {
  it('lists the entries and removes one after a delete', async () => {
    mockList.mockResolvedValue({ supported: true, items: [RULE] });
    mockDelete.mockResolvedValue(undefined);
    renderWithIntl(<OwnerlessMemoriesPanel />);
    expect(await screen.findByText(RULE.summary)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Sonnig/ }));
    await waitFor(() => { expect(screen.queryByText(RULE.summary)).toBeNull(); });
    expect(mockDelete).toHaveBeenCalledWith('mk:1');
  });

  it('says so when the entry got an owner meanwhile', async () => {
    mockList.mockResolvedValue({ supported: true, items: [RULE] });
    mockDelete.mockRejectedValue(new ApiError(409, 'x', JSON.stringify({ code: 'memory.has_owners' })));
    renderWithIntl(<OwnerlessMemoriesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Sonnig/ }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(RULE.summary)).toBeTruthy();
  });

  it('shows the empty state', async () => {
    mockList.mockResolvedValue({ supported: true, items: [] });
    renderWithIntl(<OwnerlessMemoriesPanel />);
    expect(await screen.findByText(/No memories without an owner|Keine Erinnerungen ohne Eigentümer/)).toBeTruthy();
  });
});
