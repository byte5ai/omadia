import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../../messages/en.json';
import { renderWithIntl } from '../../../_lib/test-utils';
import type { MissReportDto } from '../../../_lib/privacyReports';

/**
 * #1552 — the review queue dropped the stored turn id and showed open reports
 * only, so a resolved report vanished with no record of who resolved it. Each
 * row now links its turn to the receipt, and a filter lists resolved reports.
 */

const { mockList, mockResolve } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockResolve: vi.fn(),
}));

vi.mock('../../../_lib/privacyReports', () => ({
  listMissReports: mockList,
  resolveMissReport: mockResolve,
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    title,
    className,
  }: {
    children: React.ReactNode;
    href: string;
    title?: string;
    className?: string;
  }) => (
    <a href={href} title={title} className={className}>
      {children}
    </a>
  ),
}));

const { MissReportList } = await import('../_components/MissReportList');

const t = en.operatorPrivacyReports;
const TURN = 'turn-0123456789abcdef';

const OPEN: MissReportDto = {
  id: 'r1',
  reporter: 'alice',
  term: 'Jonas Weber',
  turnId: TURN,
  status: 'open',
  createdAt: '2026-10-28T08:00:00.000Z',
};

const RESOLVED: MissReportDto = {
  id: 'r2',
  reporter: 'alice',
  term: 'Erika Muster',
  status: 'resolved',
  resolvedBy: 'bob',
  resolvedAt: '2026-10-28T09:30:00.000Z',
  createdAt: '2026-10-27T08:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MissReportList (#1552)', () => {
  it('links the turn id to its receipt, short form in text, full id in the title', () => {
    renderWithIntl(<MissReportList initial={[OPEN]} />);
    const link = screen.getByRole('link', { name: TURN.slice(0, 8) });
    expect(link.getAttribute('href')).toBe(
      `/operator/receipts?turn=${encodeURIComponent(TURN)}`,
    );
    expect(link.getAttribute('title')).toContain(TURN);
  });

  it('shows no turn link for a report filed without a turn', () => {
    renderWithIntl(<MissReportList initial={[{ ...OPEN, turnId: undefined }]} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('loads resolved reports with who resolved them and when', async () => {
    mockList.mockResolvedValue({ items: [RESOLVED] });
    renderWithIntl(<MissReportList initial={[OPEN]} />);
    fireEvent.click(screen.getByRole('button', { name: t.filterResolved }));

    await waitFor(() => expect(mockList).toHaveBeenCalledWith('resolved'));
    const row = await screen.findByTestId('miss-report-r2');
    expect(row.textContent).toContain('resolved by bob');
    expect(row.textContent).toMatch(/2026/);
    expect(screen.queryByRole('button', { name: t.resolve })).toBeNull();
    expect(screen.getByRole('button', { name: t.filterResolved }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('lists every report under "All"', async () => {
    mockList.mockResolvedValue({ items: [OPEN, RESOLVED] });
    renderWithIntl(<MissReportList initial={[OPEN]} />);
    fireEvent.click(screen.getByRole('button', { name: t.filterAll }));
    await waitFor(() => expect(mockList).toHaveBeenCalledWith('all'));
    expect(await screen.findByTestId('miss-report-r2')).toBeTruthy();
    expect(screen.getByTestId('miss-report-r1')).toBeTruthy();
  });

  it('reloads with the current filter after resolve', async () => {
    mockList.mockResolvedValueOnce({ items: [OPEN, RESOLVED] });
    renderWithIntl(<MissReportList initial={[OPEN]} />);
    fireEvent.click(screen.getByRole('button', { name: t.filterAll }));
    await screen.findByTestId('miss-report-r2');

    mockResolve.mockResolvedValue({ ...OPEN, status: 'resolved' });
    mockList.mockResolvedValueOnce({
      items: [{ ...OPEN, status: 'resolved', resolvedBy: 'carol', resolvedAt: '2026-10-29T10:00:00.000Z' }, RESOLVED],
    });
    fireEvent.click(screen.getByRole('button', { name: t.resolve }));

    await waitFor(() => expect(mockResolve).toHaveBeenCalledWith('r1'));
    await waitFor(() => expect(mockList).toHaveBeenLastCalledWith('all'));
    expect((await screen.findByTestId('miss-report-r1')).textContent).toContain(
      'resolved by carol',
    );
  });

  it('names the empty resolved list', async () => {
    mockList.mockResolvedValue({ items: [] });
    renderWithIntl(<MissReportList initial={[]} />);
    expect(screen.getByText(t.empty)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t.filterResolved }));
    expect(await screen.findByText(t.emptyResolved)).toBeTruthy();
  });
});
