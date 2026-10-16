import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditEntryDto } from '../../../_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import AdminAuditPage from '../page';

/**
 * Admin audit log (#1315): rows render from GET /api/v1/admin/audit, a row
 * with neither actor id nor email reads as the system, paging moves the
 * offset by one page (50), and the action filter sends a prefix.
 */

const fetchMock = vi.fn();

function entry(overrides: Partial<AuditEntryDto>): AuditEntryDto {
  return {
    id: 'e1',
    actor_id: 'u1',
    actor_email: 'admin@example.com',
    action: 'user.create',
    target: 'user:u2',
    before: null,
    after: { email: 'new@example.com' },
    created_at: '2026-10-16T08:00:00.000Z',
    ...overrides,
  };
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestedUrl(call: number): URL {
  return new URL(fetchMock.mock.calls[call]?.[0] as string, 'http://localhost');
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('<AdminAuditPage />', () => {
  it('renders rows, the system actor label and pretty JSON', async () => {
    fetchMock.mockResolvedValue(
      respond({
        entries: [
          entry({}),
          entry({
            id: 'e2',
            actor_id: null,
            actor_email: null,
            action: 'plugin.install',
            target: 'plugin:de.byte5.odoo',
          }),
        ],
        limit: 50,
        offset: 0,
        has_more: false,
      }),
    );
    renderWithIntl(<AdminAuditPage />);

    expect(await screen.findByText('admin@example.com')).toBeInTheDocument();
    expect(screen.getByText('user.create')).toBeInTheDocument();
    expect(screen.getByText('plugin.install')).toBeInTheDocument();
    expect(screen.getByText('System (automatic)')).toBeInTheDocument();
    expect(screen.getAllByText(/"email": "new@example.com"/)).toHaveLength(2);

    const url = requestedUrl(0);
    expect(url.pathname).toBe('/bot-api/v1/admin/audit');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('offset')).toBe('0');
    expect(url.searchParams.has('action')).toBe(false);
  });

  it('pages to offset=50 with "Older" and back with "Newer"', async () => {
    fetchMock.mockImplementation((input: string) => {
      const offset = Number(new URL(input, 'http://localhost').searchParams.get('offset'));
      return Promise.resolve(
        respond({
          entries: [entry({ id: `e${String(offset)}`, target: `target-${String(offset)}` })],
          limit: 50,
          offset,
          has_more: offset === 0,
        }),
      );
    });
    renderWithIntl(<AdminAuditPage />);

    expect(await screen.findByText('target-0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '← Newer' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Older →' }));
    expect(await screen.findByText('target-50')).toBeInTheDocument();
    expect(requestedUrl(1).searchParams.get('offset')).toBe('50');
    expect(screen.getByRole('button', { name: 'Older →' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '← Newer' }));
    expect(await screen.findByText('target-0')).toBeInTheDocument();
    expect(requestedUrl(2).searchParams.get('offset')).toBe('0');
  });

  it('sends the selected action prefix and resets to the first page', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(respond({ entries: [], limit: 50, offset: 0, has_more: false })),
    );
    renderWithIntl(<AdminAuditPage />);
    expect(await screen.findByText('No audit entries yet.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'api_key.' } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(requestedUrl(1).searchParams.get('action')).toBe('api_key.');
    expect(requestedUrl(1).searchParams.get('offset')).toBe('0');
    expect(await screen.findByText('No audit entries match this filter.')).toBeInTheDocument();
  });

  it('shows the catalog message for an invalid query, not the raw body', async () => {
    fetchMock.mockResolvedValue(
      respond({ code: 'admin_audit.invalid_query', message: 'raw server text' }, 400),
    );
    renderWithIntl(<AdminAuditPage />);

    expect(
      await screen.findByText('The filter or page is not valid. Reset the filter and try again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/raw server text/)).toBeNull();
  });
});
