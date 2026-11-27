import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import type { McpServerNode } from '../../../_lib/agentBuilder';
import { ServerHeadersForm } from '../ServerHeadersForm';

/** #1912 — the header editor never shows a stored secret and sends "keep"
 *  (no value) for an untouched secret header. */
const { mockGet, mockSave } = vi.hoisted(() => ({ mockGet: vi.fn(), mockSave: vi.fn() }));

vi.mock('../../../_lib/agentBuilder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/agentBuilder')>()),
  getMcpServerHeaders: mockGet,
  saveMcpServerHeaders: mockSave,
}));

const SERVER = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'crm',
  transport: 'http',
  endpoint: 'https://crm.example/mcp',
  status: 'enabled',
  lastDiscoveredAt: null,
  discoveredTools: [],
} as McpServerNode;

beforeEach(() => {
  mockGet.mockReset();
  mockSave.mockReset();
  mockGet.mockResolvedValue({
    headers: [
      { name: 'x-api-key', secret: true, value: null, secretSet: true },
      { name: 'X-Tenant', secret: false, value: 'acme' },
    ],
  });
  mockSave.mockResolvedValue({ headers: [] });
});

describe('ServerHeadersForm (#1912)', () => {
  it('shows a stored secret as stored, never its value, and keeps it on save', async () => {
    const onSaved = vi.fn();
    renderWithIntl(<ServerHeadersForm server={SERVER} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByDisplayValue('x-api-key')).toBeTruthy());
    expect(screen.getByPlaceholderText(/stored — leave blank to keep/)).toBeTruthy();
    expect(screen.getByDisplayValue('acme')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Save headers' }));
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(mockSave.mock.calls[0]![1]).toEqual([
      { name: 'x-api-key', secret: true },
      { name: 'X-Tenant', secret: false, value: 'acme' },
    ]);
    expect(onSaved).toHaveBeenCalled();
  });

  it('renders nothing for a stdio server', () => {
    const { container } = renderWithIntl(
      <ServerHeadersForm server={{ ...SERVER, transport: 'stdio' }} onSaved={() => {}} />,
    );
    expect(container.textContent).toBe('');
  });
});
