import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import AdminDatasetsPage from '../page';

/**
 * Coverage for /admin/datasets (#532):
 *   - lists datasets with their row/column counts,
 *   - pages the row preview SERVER-side (limit/offset), never client-side —
 *     a dataset holds up to 50 000 rows, so a "fetch all, slice locally"
 *     regression is the failure this page exists to avoid,
 *   - surfaces the privacy-scan counts on a successful import,
 *   - refuses to delete without a confirmation,
 *   - maps the route's `dataset.*` error codes to localized copy rather than
 *     rendering the middleware's English `message` as the headline.
 */

// Hoisted together with the mock factory: `vi.mock` is lifted above the
// imports, so the stand-in ApiError has to exist by then too — the page's
// `err instanceof ApiError` branch is exactly what these tests exercise.
const {
  MockApiError,
  mockListDatasets,
  mockGetDataset,
  mockGetDatasetRows,
  mockDeleteDataset,
  mockUploadDataset,
} = vi.hoisted(() => ({
  MockApiError: class MockApiError extends Error {
    public readonly code: string | null;
    constructor(
      public status: number,
      message: string,
      public body = '',
    ) {
      super(message);
      try {
        const parsed = JSON.parse(body) as { code?: unknown };
        this.code = typeof parsed.code === 'string' ? parsed.code : null;
      } catch {
        this.code = null;
      }
    }
  },
  mockListDatasets: vi.fn(),
  mockGetDataset: vi.fn(),
  mockGetDatasetRows: vi.fn(),
  mockDeleteDataset: vi.fn(),
  mockUploadDataset: vi.fn(),
}));

vi.mock('../../../_lib/api', () => ({
  ApiError: MockApiError,
  listDatasets: mockListDatasets,
  getDataset: mockGetDataset,
  getDatasetRows: mockGetDatasetRows,
  deleteDataset: mockDeleteDataset,
  uploadDataset: mockUploadDataset,
}));

const DATASET = {
  id: 'ds-1',
  name: 'Q3 orders',
  sourceFileName: 'orders-q3.csv',
  ownerOmadiaUserId: 'user-1',
  rowCount: 4213,
  columns: [
    { name: 'order_ref', type: 'string' as const, sample: 'SO-1001' },
    { name: 'amount', type: 'number' as const, sample: '19.99' },
  ],
  createdAt: '2026-08-01T09:30:00.000Z',
};

/** Row refs start at SO-2000 so they never collide with the schema's own
 *  `sample` (SO-1001) — the two tables must be told apart in assertions. */
function rowPage(offset: number) {
  return {
    rows: Array.from({ length: 25 }, (_, i) => ({
      order_ref: `SO-${String(2000 + offset + i)}`,
      amount: 19.99,
    })),
    totalMatched: 4213,
  };
}

beforeEach(() => {
  mockListDatasets.mockResolvedValue({ items: [DATASET], totalMatched: 1 });
  mockGetDataset.mockResolvedValue(DATASET);
  mockGetDatasetRows.mockImplementation((_id: string, opts: { offset?: number }) =>
    Promise.resolve(rowPage(opts.offset ?? 0)),
  );
  mockDeleteDataset.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('<AdminDatasetsPage />', () => {
  it('lists datasets with row and column counts', async () => {
    renderWithIntl(<AdminDatasetsPage />);

    expect(await screen.findByText('Q3 orders')).toBeTruthy();
    expect(screen.getByText('orders-q3.csv')).toBeTruthy();
    expect(screen.getByText(/4,213 rows · 2 columns/)).toBeTruthy();
  });

  it('renders the empty state when the account has imported nothing', async () => {
    mockListDatasets.mockResolvedValue({ items: [], totalMatched: 0 });
    renderWithIntl(<AdminDatasetsPage />);

    expect(await screen.findByText('No datasets imported yet.')).toBeTruthy();
  });

  it('loads the schema and the first row page only when details are opened', async () => {
    const user = userEvent.setup();
    renderWithIntl(<AdminDatasetsPage />);

    await screen.findByText('Q3 orders');
    // Nothing is fetched for a collapsed row — the list alone must not cost
    // one detail + one rows request per dataset.
    expect(mockGetDatasetRows).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Schema & rows' }));

    await waitFor(() =>
      expect(mockGetDatasetRows).toHaveBeenCalledWith('ds-1', {
        limit: 25,
        offset: 0,
      }),
    );
    // Twice on purpose: once as a schema row, once as a preview-table header.
    expect(await screen.findAllByText('order_ref')).toHaveLength(2);
    // The type the importer derived, not the raw CSV string it came from.
    expect(screen.getByText('number')).toBeTruthy();
    // Schema sample value…
    expect(screen.getByText('SO-1001')).toBeTruthy();
    // …and a real row from the preview page.
    expect(screen.getByText('SO-2000')).toBeTruthy();
    expect(screen.getByText('Showing 1–25 of 4,213 rows')).toBeTruthy();
  });

  it('pages the preview server-side with a new offset', async () => {
    const user = userEvent.setup();
    renderWithIntl(<AdminDatasetsPage />);

    await screen.findByText('Q3 orders');
    await user.click(screen.getByRole('button', { name: 'Schema & rows' }));
    await screen.findByText('Showing 1–25 of 4,213 rows');

    // "Back" is unreachable on the first page.
    expect(
      (screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() =>
      expect(mockGetDatasetRows).toHaveBeenLastCalledWith('ds-1', {
        limit: 25,
        offset: 25,
      }),
    );
    expect(await screen.findByText('Showing 26–50 of 4,213 rows')).toBeTruthy();
    // The schema is read once, on open — turning a page costs one request,
    // not two.
    expect(mockGetDataset).toHaveBeenCalledTimes(1);
  });

  it('pages the dataset LIST server-side and shows the real total (#532 must-fix 1)', async () => {
    // 60 datasets — more than one page. The pre-pagination page served the
    // newest 50 with no hint that 10 more existed and no way to delete them.
    const user = userEvent.setup();
    const all = Array.from({ length: 60 }, (_, i) => ({
      ...DATASET,
      id: `ds-${String(i)}`,
      name: `Dataset ${String(i)}`,
    }));
    mockListDatasets.mockImplementation(
      (opts: { limit?: number; offset?: number } = {}) => {
        const offset = opts.offset ?? 0;
        return Promise.resolve({
          items: all.slice(offset, offset + (opts.limit ?? 50)),
          totalMatched: 60,
        });
      },
    );
    renderWithIntl(<AdminDatasetsPage />);

    expect(await screen.findByText('Showing 1–50 of 60 datasets')).toBeTruthy();
    expect(mockListDatasets).toHaveBeenCalledWith({ limit: 50, offset: 0 });
    expect(
      (screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Showing 51–60 of 60 datasets')).toBeTruthy();
    expect(mockListDatasets).toHaveBeenLastCalledWith({ limit: 50, offset: 50 });
    // The formerly unreachable 51st dataset is now listed — and deletable.
    expect(screen.getByText('Dataset 50')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('hides the pager when one page holds everything', async () => {
    renderWithIntl(<AdminDatasetsPage />);

    await screen.findByText('Q3 orders');
    expect(screen.queryByText(/of 1 datasets/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });

  it('steps back a page when the last dataset of the last page is deleted', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    let deleted = false;
    const all = Array.from({ length: 51 }, (_, i) => ({
      ...DATASET,
      id: `ds-${String(i)}`,
      name: `Dataset ${String(i)}`,
    }));
    mockListDatasets.mockImplementation(
      (opts: { limit?: number; offset?: number } = {}) => {
        const remaining = deleted ? all.slice(0, 50) : all;
        const offset = opts.offset ?? 0;
        return Promise.resolve({
          items: remaining.slice(offset, offset + (opts.limit ?? 50)),
          totalMatched: remaining.length,
        });
      },
    );
    mockDeleteDataset.mockImplementation(() => {
      deleted = true;
      return Promise.resolve(undefined);
    });
    renderWithIntl(<AdminDatasetsPage />);

    await screen.findByText('Showing 1–50 of 51 datasets');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Showing 51–51 of 51 datasets');

    // Page 2 holds exactly one dataset — delete it.
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    // The now-empty page 2 is not rendered as "no datasets"; the page steps
    // back and shows the (single, pager-less) remaining page.
    expect(await screen.findByText('Dataset 0')).toBeTruthy();
    expect(mockListDatasets).toHaveBeenLastCalledWith({ limit: 50, offset: 0 });
    expect(screen.queryByText('No datasets imported yet.')).toBeNull();
  });

  it('falls back to an explicit cap warning when the backend cannot count', async () => {
    // A graph implementation predating `countDatasets` sends no totalMatched.
    mockListDatasets.mockResolvedValue({
      items: Array.from({ length: 50 }, (_, i) => ({
        ...DATASET,
        id: `ds-${String(i)}`,
        name: `Dataset ${String(i)}`,
      })),
    });
    renderWithIntl(<AdminDatasetsPage />);

    expect(await screen.findByText(/Showing the 50 most recent datasets/)).toBeTruthy();
  });

  it('reports the privacy-scan counts after an import', async () => {
    const user = userEvent.setup();
    mockUploadDataset.mockResolvedValue({
      dataset: { datasetId: 'ds-2', rowCount: 120, graphNodeId: 'node-2' },
      privacyScan: { scannedCells: 480, maskedCells: 12 },
      truncation: { truncatedCellCount: 0, truncatedColumns: [] },
    });
    renderWithIntl(<AdminDatasetsPage />);
    await screen.findByText('Q3 orders');

    const file = new File(['a,b\n1,2\n'], 'sales.csv', { type: 'text/csv' });
    await user.upload(screen.getByLabelText('CSV file'), file);
    await user.click(screen.getByRole('button', { name: 'Import' }));

    expect(
      await screen.findByText('Privacy scan: 480 cells checked, 12 masked.'),
    ).toBeTruthy();
    expect(screen.getByText('Import complete — 120 rows stored.')).toBeTruthy();
    // The list is re-read so the new dataset appears without a manual refresh.
    expect(mockListDatasets).toHaveBeenCalledTimes(2);
  });

  it('clears the file input after an import so the SAME file can be re-imported', async () => {
    // Found by clicking the real page: a file input is uncontrolled, so
    // resetting `file` state leaves the element holding the old filename.
    // Re-picking that same file fires no `change` event, and the Import
    // button stays disabled with the element still showing a file — dead UI
    // with no explanation. The element itself must be reset.
    const user = userEvent.setup();
    mockUploadDataset.mockResolvedValue({
      dataset: { datasetId: 'ds-4', rowCount: 2, graphNodeId: 'node-4' },
      privacyScan: { scannedCells: 4, maskedCells: 0 },
      truncation: { truncatedCellCount: 0, truncatedColumns: [] },
    });
    renderWithIntl(<AdminDatasetsPage />);
    await screen.findByText('Q3 orders');

    const input = screen.getByLabelText('CSV file') as HTMLInputElement;
    const file = new File(['a,b\n1,2\n'], 'again.csv', { type: 'text/csv' });

    await user.upload(input, file);
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText('Import complete — 2 rows stored.');

    // The element is empty, so selecting the same file again is a real change.
    expect(input.value).toBe('');
    expect(input.files?.length ?? 0).toBe(0);

    await user.upload(input, file);
    expect(
      (screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('flags truncated cells instead of importing them silently', async () => {
    const user = userEvent.setup();
    mockUploadDataset.mockResolvedValue({
      dataset: { datasetId: 'ds-3', rowCount: 4, graphNodeId: 'node-3' },
      privacyScan: { scannedCells: 16, maskedCells: 0 },
      truncation: { truncatedCellCount: 3, truncatedColumns: ['notes'] },
    });
    renderWithIntl(<AdminDatasetsPage />);
    await screen.findByText('Q3 orders');

    await user.upload(
      screen.getByLabelText('CSV file'),
      new File(['x'], 'big.csv', { type: 'text/csv' }),
    );
    await user.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByText(/3 cells exceeded/)).toBeTruthy();
    expect(screen.getByText(/Affected columns: notes/)).toBeTruthy();
  });

  it('never deletes without a confirmation', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    renderWithIntl(<AdminDatasetsPage />);

    await screen.findByText('Q3 orders');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(mockDeleteDataset).not.toHaveBeenCalled();
  });

  it('deletes and reloads once confirmed', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    renderWithIntl(<AdminDatasetsPage />);

    await screen.findByText('Q3 orders');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mockDeleteDataset).toHaveBeenCalledWith('ds-1'));
    expect(mockListDatasets).toHaveBeenCalledTimes(2);
  });

  it('reports a failed delete in its own error slot and resyncs the list', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    mockDeleteDataset.mockRejectedValue(
      new MockApiError(500, 'boom', JSON.stringify({ code: 'dataset.internal_error' })),
    );
    renderWithIntl(<AdminDatasetsPage />);

    await screen.findByText('Q3 orders');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    // The delete failure is NOT dressed up as a list-load failure (#598
    // review must-fix 3) — the list stays rendered next to the error.
    expect(await screen.findByText('The request failed (HTTP 500).')).toBeTruthy();
    expect(screen.getByText('Q3 orders')).toBeTruthy();
    expect(screen.queryByText(/Loading failed/)).toBeNull();
    // And the list is re-read: the server may have deleted the row despite
    // the error, and a stale row invites a second delete.
    expect(mockListDatasets).toHaveBeenCalledTimes(2);
  });

  it('never renders one dataset’s rows under another’s schema (#598 must-fix 2)', async () => {
    // Open A (slow rows fetch), then switch to B (fast). A's response lands
    // LAST — without the request guard it would overwrite B's panel.
    const user = userEvent.setup();
    const datasetB = {
      ...DATASET,
      id: 'ds-2',
      name: 'Suppliers',
      sourceFileName: 'suppliers.csv',
      columns: [{ name: 'supplier', type: 'string' as const, sample: 'ACME' }],
    };
    mockListDatasets.mockResolvedValue({
      items: [DATASET, datasetB],
      totalMatched: 2,
    });
    mockGetDataset.mockImplementation((id: string) =>
      Promise.resolve(id === 'ds-1' ? DATASET : datasetB),
    );
    let resolveA!: (page: ReturnType<typeof rowPage>) => void;
    mockGetDatasetRows.mockImplementation((id: string) => {
      if (id === 'ds-1') {
        return new Promise((resolve) => {
          resolveA = resolve;
        });
      }
      return Promise.resolve({
        rows: [{ supplier: 'ACME Corp' }],
        totalMatched: 1,
      });
    });
    renderWithIntl(<AdminDatasetsPage />);
    await screen.findByText('Suppliers');

    const toggles = screen.getAllByRole('button', { name: 'Schema & rows' });
    await user.click(toggles[0]!); // A — its rows promise stays pending
    await user.click(toggles[1]!); // B — resolves immediately
    await screen.findByText('ACME Corp');

    resolveA(rowPage(0)); // A's stale response lands after B is open
    // Let A's promise chain fully flush before asserting it changed nothing.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('SO-2000')).toBeNull();
    expect(screen.getByText('ACME Corp')).toBeTruthy();
  });

  it('translates a dataset.* error code rather than showing the raw message', async () => {
    const user = userEvent.setup();
    mockUploadDataset.mockRejectedValue(
      new MockApiError(
        422,
        'POST /v1/datasets failed: 422',
        JSON.stringify({
          code: 'dataset.unsupported_type',
          message: 'Nur CSV-Dateien werden aktuell unterstützt (v1 scope, siehe #430).',
        }),
      ),
    );
    renderWithIntl(<AdminDatasetsPage />);
    await screen.findByText('Q3 orders');

    // Named .csv so the input's own `accept` filter lets it through — the
    // rejection under test is the SERVER's (`isCsvAttachment` also inspects
    // the mimetype), which is the only one that can be trusted anyway.
    await user.upload(
      screen.getByLabelText('CSV file'),
      new File(['x'], 'notes.csv', { type: 'text/plain' }),
    );
    await user.click(screen.getByRole('button', { name: 'Import' }));

    expect(
      await screen.findByText('Only CSV files are supported so far.'),
    ).toBeTruthy();
    // The server's own (English-only, untranslated) message is not the headline.
    expect(screen.queryByText(/v1 scope, siehe #430/)).toBeNull();
  });

  it('maps a 413 to the upload-limit copy', async () => {
    const user = userEvent.setup();
    mockUploadDataset.mockRejectedValue(
      new MockApiError(413, 'too large', JSON.stringify({ code: 'dataset.limit_file_size' })),
    );
    renderWithIntl(<AdminDatasetsPage />);
    await screen.findByText('Q3 orders');

    await user.upload(
      screen.getByLabelText('CSV file'),
      new File(['x'], 'huge.csv', { type: 'text/csv' }),
    );
    await user.click(screen.getByRole('button', { name: 'Import' }));

    expect(
      await screen.findByText('The file exceeds the 25 MB upload limit.'),
    ).toBeTruthy();
  });
});
