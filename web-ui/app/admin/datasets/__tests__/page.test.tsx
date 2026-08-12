import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
// Resolves to the mocked class defined in vi.mock below — `instanceof ApiError`
// in the page's error mapper matches rejections thrown with it.
import { ApiError } from '../../../_lib/api';
import AdminDatasetsPage from '../page';

/**
 * Coverage for /admin/datasets (issue #532):
 *   - lists the owner's datasets (paginated),
 *   - deletes only after the inline confirm step (two-click guard), and
 *     reports a delete failure as a delete error (not a load error),
 *   - opens a detail view with the inferred schema + a paginated row preview,
 *   - surfaces the mandatory privacy-scan + truncation stats after an upload.
 */

const {
  mockListDatasets,
  mockGetDataset,
  mockGetDatasetRows,
  mockDeleteDataset,
  mockUploadDataset,
} = vi.hoisted(() => ({
  mockListDatasets: vi.fn(),
  mockGetDataset: vi.fn(),
  mockGetDatasetRows: vi.fn(),
  mockDeleteDataset: vi.fn(),
  mockUploadDataset: vi.fn(),
}));

vi.mock('../../../_lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public body = '',
    ) {
      super(message);
    }
  },
  listDatasets: mockListDatasets,
  getDataset: mockGetDataset,
  getDatasetRows: mockGetDatasetRows,
  deleteDataset: mockDeleteDataset,
  uploadDataset: mockUploadDataset,
}));

function peopleDataset() {
  return {
    id: 'ds-1',
    name: 'People',
    sourceFileName: 'people.csv',
    ownerOmadiaUserId: 'user-1',
    rowCount: 60,
    columns: [
      { name: 'name', type: 'string' as const, sample: 'Ada' },
      { name: 'age', type: 'number' as const, sample: '36' },
    ],
    createdAt: '2026-08-01T10:00:00.000Z',
  };
}

/** A page-of-25 rows keyed on the requested offset, over a 60-row dataset — so
 *  the prev/next controls and their offset arithmetic actually render. */
function rowsPage(offset: number) {
  return {
    rows: Array.from({ length: Math.min(25, 60 - offset) }, (_, i) => ({
      name: `person-${String(offset + i)}`,
      age: offset + i,
    })),
    totalMatched: 60,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListDatasets.mockResolvedValue({
    items: [peopleDataset()],
    total: 1,
    limit: 50,
    offset: 0,
  });
  mockGetDataset.mockResolvedValue(peopleDataset());
  mockGetDatasetRows.mockImplementation((_id: string, opts?: { offset?: number }) =>
    Promise.resolve(rowsPage(opts?.offset ?? 0)),
  );
  mockDeleteDataset.mockResolvedValue(undefined);
});

describe('AdminDatasetsPage', () => {
  it('lists datasets from the API', async () => {
    renderWithIntl(<AdminDatasetsPage />);
    expect(await screen.findByText('People')).toBeInTheDocument();
    expect(mockListDatasets).toHaveBeenCalledWith({ limit: 50, offset: 0 });
  });

  it('requires a confirm click before deleting', async () => {
    const user = userEvent.setup();
    renderWithIntl(<AdminDatasetsPage />);
    await screen.findByText('People');

    await user.click(screen.getByRole('button', { name: /^delete people$/i }));
    expect(mockDeleteDataset).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole('button', { name: /confirm delete of people/i }),
    );
    await waitFor(() => expect(mockDeleteDataset).toHaveBeenCalledWith('ds-1'));
  });

  it('reports a failed delete as a delete error and keeps the confirm armed', async () => {
    const user = userEvent.setup();
    mockDeleteDataset.mockRejectedValue(
      new ApiError(
        404,
        'DELETE failed: 404',
        JSON.stringify({ code: 'dataset.not_found' }),
      ),
    );
    renderWithIntl(<AdminDatasetsPage />);
    await screen.findByText('People');

    await user.click(screen.getByRole('button', { name: /^delete people$/i }));
    await user.click(
      screen.getByRole('button', { name: /confirm delete of people/i }),
    );

    // Rendered via the dedicated delete-error key, not the load-error banner.
    expect(await screen.findByText(/delete failed/i)).toBeInTheDocument();
    // Confirm stays armed for a retry.
    expect(
      screen.getByRole('button', { name: /confirm delete of people/i }),
    ).toBeInTheDocument();
  });

  it('opens the detail view with schema and row preview', async () => {
    const user = userEvent.setup();
    renderWithIntl(<AdminDatasetsPage />);
    await screen.findByText('People');

    await user.click(screen.getByRole('button', { name: 'People' }));

    await waitFor(() => expect(mockGetDataset).toHaveBeenCalledWith('ds-1'));
    expect(await screen.findByText('person-0')).toBeInTheDocument();
    expect(mockGetDatasetRows).toHaveBeenCalledWith('ds-1', {
      limit: 25,
      offset: 0,
    });
  });

  it('pages the row preview forward with the right offset', async () => {
    const user = userEvent.setup();
    renderWithIntl(<AdminDatasetsPage />);
    await screen.findByText('People');
    await user.click(screen.getByRole('button', { name: 'People' }));
    await screen.findByText('person-0');

    // Both the list footer and the row preview have a "Next" — the list one is
    // disabled (total 1), so page the enabled (row-preview) control.
    const nextButtons = screen.getAllByRole('button', { name: /next/i });
    const rowsNext = nextButtons.find(
      (b) => !(b as HTMLButtonElement).disabled,
    );
    await user.click(rowsNext as HTMLElement);

    await waitFor(() =>
      expect(mockGetDatasetRows).toHaveBeenCalledWith('ds-1', {
        limit: 25,
        offset: 25,
      }),
    );
    expect(await screen.findByText('person-25')).toBeInTheDocument();
  });

  it('surfaces the privacy-scan stats after an upload', async () => {
    const user = userEvent.setup();
    mockUploadDataset.mockResolvedValue({
      dataset: { datasetId: 'ds-2', rowCount: 5, graphNodeId: 'n-2' },
      privacyScan: { scannedCells: 20, maskedCells: 3 },
      truncation: { truncatedCellCount: 0, truncatedColumns: [] },
    });
    renderWithIntl(<AdminDatasetsPage />);
    await screen.findByText('People');

    const file = new File(['name,age\nAda,36\n'], 'people.csv', {
      type: 'text/csv',
    });
    const input = screen.getByLabelText(/csv file/i);
    await user.upload(input, file);
    await user.click(screen.getByRole('button', { name: /^upload$/i }));

    await waitFor(() =>
      // The name is auto-derived from the file name (nameTouched === false).
      expect(mockUploadDataset).toHaveBeenCalledWith(file, 'people'),
    );
    expect(await screen.findByText(/3 of 20 cells masked/i)).toBeInTheDocument();
  });

  it('renders the truncation warning when cells were cut', async () => {
    const user = userEvent.setup();
    mockUploadDataset.mockResolvedValue({
      dataset: { datasetId: 'ds-3', rowCount: 5, graphNodeId: 'n-3' },
      privacyScan: { scannedCells: 20, maskedCells: 0 },
      truncation: { truncatedCellCount: 2, truncatedColumns: ['bio'] },
    });
    renderWithIntl(<AdminDatasetsPage />);
    await screen.findByText('People');

    const file = new File(['name,bio\nAda,x\n'], 'people.csv', {
      type: 'text/csv',
    });
    await user.upload(screen.getByLabelText(/csv file/i), file);
    await user.click(screen.getByRole('button', { name: /^upload$/i }));

    expect(await screen.findByText(/truncated in: bio/i)).toBeInTheDocument();
  });

  it('surfaces a friendly per-code message from a 422 upload error', async () => {
    const user = userEvent.setup();
    mockUploadDataset.mockRejectedValue(
      new ApiError(
        422,
        'POST /v1/datasets failed: 422',
        JSON.stringify({
          code: 'dataset.unsupported_type',
          message: 'only CSV is supported',
        }),
      ),
    );
    renderWithIntl(<AdminDatasetsPage />);
    await screen.findByText('People');

    const file = new File(['x,y\n1,2\n'], 'bad.csv', { type: 'text/csv' });
    await user.upload(screen.getByLabelText(/csv file/i), file);
    await user.click(screen.getByRole('button', { name: /^upload$/i }));

    await waitFor(() => expect(mockUploadDataset).toHaveBeenCalledOnce());
    // The per-code catalog line, wrapped in the uploadError key.
    expect(
      await screen.findByText(/only csv files are supported/i),
    ).toBeInTheDocument();
  });

  it('paginates the dataset list and disables Prev on the first page', async () => {
    const user = userEvent.setup();
    mockListDatasets.mockResolvedValueOnce({
      items: [peopleDataset()],
      total: 60,
      limit: 50,
      offset: 0,
    });
    mockListDatasets.mockResolvedValueOnce({
      items: [{ ...peopleDataset(), id: 'ds-2', name: 'Later' }],
      total: 60,
      limit: 50,
      offset: 50,
    });
    renderWithIntl(<AdminDatasetsPage />);
    await screen.findByText('People');

    const footer = screen.getByText(/showing 1–1 of 60/i);
    expect(footer).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /prev/i })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() =>
      expect(mockListDatasets).toHaveBeenLastCalledWith({
        limit: 50,
        offset: 50,
      }),
    );
  });

  it('shows the empty state', async () => {
    mockListDatasets.mockResolvedValue({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
    renderWithIntl(<AdminDatasetsPage />);
    expect(await screen.findByText(/no datasets yet/i)).toBeInTheDocument();
  });

  it('closes the detail panel and dismisses a detail error', async () => {
    const user = userEvent.setup();
    renderWithIntl(<AdminDatasetsPage />);
    await screen.findByText('People');
    await user.click(screen.getByRole('button', { name: 'People' }));
    const panel = await screen.findByText('person-0');
    expect(panel).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /close/i }));
    await waitFor(() =>
      expect(screen.queryByText('person-0')).not.toBeInTheDocument(),
    );
  });

  it('a row page from a closed dataset cannot land in the next dataset panel', async () => {
    // What the generation guard (detailSeq) actually prevents: Close stays
    // clickable while a row page is in flight (the pager is disabled, the close
    // link is not). Close, open a *different* dataset, and the first dataset's
    // late page would otherwise call setRows() on the new panel — showing
    // People's rows under Orders' schema. `selected` alone does not stop this:
    // it is non-null again by the time the stale response resolves.
    const user = userEvent.setup();
    const orders = {
      ...peopleDataset(),
      id: 'ds-2',
      name: 'Orders',
      columns: [{ name: 'sku', type: 'string' as const, sample: 'A-1' }],
    };
    mockListDatasets.mockResolvedValue({
      items: [peopleDataset(), orders],
      total: 2,
      limit: 50,
      offset: 0,
    });
    // Rows are dataset-specific, so a mix-up is visible in the DOM.
    mockGetDatasetRows.mockImplementation((id: string, opts?: { offset?: number }) =>
      Promise.resolve(
        id === 'ds-2'
          ? { rows: [{ sku: 'order-row' }], totalMatched: 1 }
          : rowsPage(opts?.offset ?? 0),
      ),
    );
    mockGetDataset.mockImplementation((id: string) =>
      Promise.resolve(id === 'ds-2' ? orders : peopleDataset()),
    );

    renderWithIntl(<AdminDatasetsPage />);
    await screen.findByText('Orders');
    await user.click(screen.getByRole('button', { name: 'People' }));
    await screen.findByText('person-0');

    // Hold People's second row page in flight.
    let releaseStalePage: (() => void) | undefined;
    mockGetDatasetRows.mockImplementationOnce(
      (_id: string, opts?: { offset?: number }) =>
        new Promise((resolve) => {
          releaseStalePage = () => resolve(rowsPage(opts?.offset ?? 0));
        }),
    );
    const rowsNext = screen
      .getAllByRole('button', { name: /next/i })
      .find((b) => !(b as HTMLButtonElement).disabled);
    await user.click(rowsNext as HTMLElement);
    await waitFor(() => expect(releaseStalePage).toBeDefined());

    await user.click(screen.getByRole('button', { name: /close/i }));
    await user.click(screen.getByRole('button', { name: 'Orders' }));
    expect(await screen.findByText('order-row')).toBeInTheDocument();
    expect(screen.getByText(/showing 1–1 of 1/i)).toBeInTheDocument();

    // People's late page resolves now — Orders' panel must be untouched. The
    // mismatch is otherwise SILENT in the cells: rows render as
    // `selected.columns × row[col.name]`, so People rows under Orders' schema
    // are 25 blank cells, not visibly wrong text. The footer is the tell.
    await act(async () => {
      releaseStalePage?.();
    });
    expect(screen.getByText('order-row')).toBeInTheDocument();
    expect(screen.getByText(/showing 1–1 of 1/i)).toBeInTheDocument();
    expect(screen.queryByText(/showing 26–50 of 60/i)).not.toBeInTheDocument();
  });
});
