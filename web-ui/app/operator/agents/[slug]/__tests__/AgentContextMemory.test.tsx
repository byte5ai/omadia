import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import { ApiError } from '../../../../_lib/api';
import type { ContextMemoryDto } from '../../../../_lib/agents';
import { AgentContextMemory } from '../_components/AgentContextMemory';

/**
 * Issue #899 (epic #860) — operator control for the W5 chat-context memory
 * ACL.
 *
 * The behaviours worth pinning are the SAFETY ones, not the rendering:
 *
 *  - enabling is gated behind seeing the three semantics, because an operator
 *    who has not read them will read the ACL's contract as a bug;
 *  - disabling is NOT gated — the safe direction must never be harder than
 *    the unsafe one;
 *  - a mode the client does not know narrows to `off`, so the panel can never
 *    claim an agent is enforcing when the runtime would route it as off.
 */

const { mockGet, mockSet } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSet: vi.fn(),
}));

// Spread the real module so the mode narrowing and the error-code parser —
// the shared contracts this UI depends on — stay genuine; only the two
// network calls are stubbed.
vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  getAgentContextMemory: mockGet,
  setAgentContextMemory: mockSet,
}));

function dto(overrides: Partial<ContextMemoryDto> = {}): ContextMemoryDto {
  return {
    slug: 'sales-bot',
    mode: 'off',
    modes: ['off', 'enforce', 'enforce-strict'],
    ...overrides,
  };
}

beforeEach(() => {
  mockGet.mockReset();
  mockSet.mockReset();
  mockGet.mockResolvedValue(dto());
  mockSet.mockImplementation((_slug: string, mode: string) =>
    Promise.resolve({ ok: true, mode }),
  );
});

async function render(initial?: Partial<ContextMemoryDto>): Promise<void> {
  if (initial) mockGet.mockResolvedValue(dto(initial));
  renderWithIntl(<AgentContextMemory slug="sales-bot" />);
  await waitFor(() => expect(mockGet).toHaveBeenCalledWith('sales-bot'));
  await screen.findByRole('radio', { name: /Off/i });
}

describe('AgentContextMemory (#899)', () => {
  it('renders one radio per server-advertised mode and preselects the saved one', async () => {
    await render({ mode: 'enforce' });
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: /Separate per context/i })).toBeChecked();
  });

  it('follows the SERVER mode list, not the bundled constant', async () => {
    // A middleware that drops a mode must not leave a dead radio behind: the
    // control renders what the server says it accepts.
    await render({ modes: ['off', 'enforce'] });
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('narrows an unknown persisted mode to off', async () => {
    // Deny-default. Showing "enforcing" for a value the runtime routes as off
    // is worse than showing off, because it stops the operator from fixing it.
    await render({ mode: 'enforce-super-strict' as ContextMemoryDto['mode'] });
    expect(screen.getByRole('radio', { name: /Off/i })).toBeChecked();
  });

  it('save is disabled until something actually changes', async () => {
    await render();
    expect(screen.getByRole('button', { name: /Save/i })).toBeDisabled();
  });

  it('ENABLING shows the three semantics and blocks save until acknowledged', async () => {
    const user = userEvent.setup();
    await render();
    await user.click(screen.getByRole('radio', { name: /Separate per context/i }));

    // All three semantics from the issue must be on screen BEFORE the switch.
    expect(screen.getByText(/shared team tier/i)).toBeInTheDocument();
    expect(screen.getByText(/read-only for context turns/i)).toBeInTheDocument();
    expect(screen.getByText(/Turns from the API carry no chat context/i)).toBeInTheDocument();

    const save = screen.getByRole('button', { name: /Save/i });
    expect(save).toBeDisabled();
    expect(mockSet).not.toHaveBeenCalled();

    await user.click(screen.getByRole('checkbox'));
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith('sales-bot', 'enforce'));
  });

  it('re-arms the acknowledgement when the operator picks a different mode', async () => {
    // An acknowledgement is about the mode it was given for. Carrying it over
    // would let a click on `enforce` unlock a save of `enforce-strict`.
    const user = userEvent.setup();
    await render();
    await user.click(screen.getByRole('radio', { name: /Separate per context/i }));
    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: /Save/i })).toBeEnabled();

    await user.click(screen.getByRole('radio', { name: /Separate and sealed/i }));
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', { name: /Save/i })).toBeDisabled();
  });

  it('DISABLING needs no acknowledgement — the safe direction is never gated', async () => {
    const user = userEvent.setup();
    await render({ mode: 'enforce' });
    await user.click(screen.getByRole('radio', { name: /Off/i }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Save/i }));
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith('sales-bot', 'off'));
  });

  it('tightening enforce → enforce-strict needs no acknowledgement', async () => {
    const user = userEvent.setup();
    await render({ mode: 'enforce' });
    await user.click(screen.getByRole('radio', { name: /Separate and sealed/i }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Save/i }));
    await waitFor(() =>
      expect(mockSet).toHaveBeenCalledWith('sales-bot', 'enforce-strict'),
    );
  });

  it('renders a LOCALIZED message for a machine error code, never the raw body', async () => {
    const user = userEvent.setup();
    await render();
    mockSet.mockRejectedValue(
      new ApiError(404, 'boom', JSON.stringify({ error: 'not_found' })),
    );
    await user.click(screen.getByRole('radio', { name: /Separate per context/i }));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Save/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/does not exist anymore/i);
    expect(alert.textContent).not.toContain('not_found');
  });

  it('keeps the operator selection after a failed save', async () => {
    // Re-reading the server value here would erase the choice they are trying
    // to make and hide which mode the failed write was for.
    const user = userEvent.setup();
    await render();
    mockSet.mockRejectedValue(new ApiError(500, 'boom', '{}'));
    await user.click(screen.getByRole('radio', { name: /Separate per context/i }));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Save/i }));

    await screen.findByRole('alert');
    expect(screen.getByRole('radio', { name: /Separate per context/i })).toBeChecked();
  });

  it('surfaces a load failure as localized copy and renders no control', async () => {
    mockGet.mockRejectedValue(new ApiError(503, 'boom', '{}'));
    renderWithIntl(<AgentContextMemory slug="sales-bot" />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBeTruthy();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });
});
