import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import type { PublicMcpKeyBinding } from '../../../_lib/agentBuilder';
import AdminMcpPage from '../page';

/**
 * Issue #571 — a binding whose `key_id`/`agent_id` does not resolve is a dead
 * row that LOOKS configured. The server annotates such rows with a warning; this
 * pane must render that warning so a typo is visually distinguishable from a
 * working binding. These tests pin the visible half of the fix: the badge
 * appears when — and only when — the server flagged the row.
 */

const { mockListBindings, mockListOrchestrators, mockListServers } = vi.hoisted(() => ({
  mockListBindings: vi.fn(),
  mockListOrchestrators: vi.fn(),
  mockListServers: vi.fn(),
}));

vi.mock('../../../_lib/agentBuilder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/agentBuilder')>()),
  listPublicMcpKeyBindings: mockListBindings,
  listMcpOrchestrators: mockListOrchestrators,
  listMcpServers: mockListServers,
}));

function binding(overrides: Partial<PublicMcpKeyBinding>): PublicMcpKeyBinding {
  return {
    keyId: 'key-1',
    agentId: 'sales',
    readTools: [],
    writeTools: [],
    writeRateLimitPerMinute: 5,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockListServers.mockResolvedValue({ servers: [] });
  mockListOrchestrators.mockResolvedValue({ orchestrators: [] });
  mockListBindings.mockReset();
});

async function openBindingsTab(): Promise<void> {
  const user = userEvent.setup();
  renderWithIntl(<AdminMcpPage />);
  await user.click(screen.getByRole('button', { name: 'Public API keys' }));
}

describe('BindingsPane — #571 dead-binding warnings', () => {
  it('renders the key-unknown warning on a row the server flagged', async () => {
    mockListBindings.mockResolvedValue({
      bindings: [
        binding({
          keyId: 'typoed-key',
          warnings: [{ code: 'key_id_unknown', message: 'server english fallback' }],
        }),
      ],
    });

    await openBindingsTab();

    // Rendered from the locale catalog, not the server's English `message`.
    await waitFor(() =>
      expect(screen.getByText(/No API key with this id exists yet/i)).toBeTruthy(),
    );
    // The server's raw message is deliberately NOT shown.
    expect(screen.queryByText('server english fallback')).toBeNull();
  });

  it('renders the agent-unknown warning for a row bound to a vanished agent', async () => {
    mockListBindings.mockResolvedValue({
      bindings: [
        binding({
          keyId: 'orphan',
          agentId: 'deleted-agent',
          warnings: [{ code: 'agent_id_unknown', message: 'x' }],
        }),
      ],
    });

    await openBindingsTab();

    await waitFor(() =>
      expect(screen.getByText(/names an agent that is no longer registered/i)).toBeTruthy(),
    );
  });

  it('shows NO warning on a clean binding — a healthy row is unchanged', async () => {
    mockListBindings.mockResolvedValue({ bindings: [binding({ keyId: 'healthy' })] });

    await openBindingsTab();

    await waitFor(() => expect(screen.getByText('healthy')).toBeTruthy());
    expect(screen.queryByText(/No API key with this id exists yet/i)).toBeNull();
    expect(screen.queryByText(/no longer registered/i)).toBeNull();
  });
});
