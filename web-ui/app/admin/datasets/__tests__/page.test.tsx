import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
// Resolves to the mocked class defined in vi.mock below — `instanceof ApiError`
// in the page's error mapper matches rejections thrown with it.
import { ApiError } from '../../../_lib/api';
import AdminDatasetsPage from '../page';

/**
 * Coverage for /admin/datasets (issue #532):
 *   - lists the owner's datasets,
 *   - deletes only after the inline confirm step (two-click guard),
 *   - opens a detail view with the inferred schema + a row preview,
 *   - surfaces the mandatory privacy-scan stats after an upload.
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
    rowCount: 2,
    columns: [
      { name: 'name', type: 'string' as const, sample: 'Ada' },
      { name: 'age', type: 'number' as const, sample: '36' },
    ],
    createdAt: '2026-08-01T10:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListDatasets.mockResolvedValue([peopleDataset()]);
  mockGetDataset.mockResolvedValue(peopleDataset());
  mockGetDatasetRows.mockResolvedValue({
    rows: [
      { name: 'Ada', age: 36 },
      { name: 'Alan', age: 41 },
    ],
    totalMatched: 2,
  });
  mockDeleteDataset.mockResolvedValue(undefined);
});

describe('AdminDatasetsPage', () => {
  it('lists datasets from the API', async () => {
    renderWithIntl(<AdminDatasetsPage />);
    expect(await screen.findByText('People')).toBeInTheDocument();
    expect(mockListDatasets).toHaveBeenCalledOnce();
  });

  it('requires a confirm click before deleting', async () => {
    const user = userEvent.setup();
    renderWithIntl(<AdminDatasetsPage />);
    await screen.findByText('People');

    await user.click(screen.getByRole('button', { name: /delete/i }));
    expect(mockDeleteDataset).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /confirm delete/i }));
    await waitFor(() => expect(mockDeleteDataset).toHaveBeenCalledWith('ds-1'));
  });

  it('opens the detail view with schema and row preview', async () => {
    const user = userEvent.setup();
    renderWithIntl(<AdminDatasetsPage />);
    await screen.findByText('People');

    await user.click(screen.getByRole('button', { name: 'People' }));

    await waitFor(() => expect(mockGetDataset).toHaveBeenCalledWith('ds-1'));
    // Row preview is rendered ('Alan' is unique to the rows, not the schema sample).
    expect(await screen.findByText('Alan')).toBeInTheDocument();
    expect(mockGetDatasetRows).toHaveBeenCalledWith('ds-1', {
      limit: 25,
      offset: 0,
    });
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

    await waitFor(() => expect(mockUploadDataset).toHaveBeenCalledOnce());
    expect(await screen.findByText(/3 of 20 cells masked/i)).toBeInTheDocument();
  });

  it('surfaces a friendly message from the {code} of a 422 upload error', async () => {
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

    // A .csv passes the input's `accept` filter; the 422 is simulated by the
    // mock, so the file's actual content is irrelevant.
    const file = new File(['x,y\n1,2\n'], 'bad.csv', { type: 'text/csv' });
    await user.upload(screen.getByLabelText(/csv file/i), file);
    await user.click(screen.getByRole('button', { name: /^upload$/i }));

    await waitFor(() => expect(mockUploadDataset).toHaveBeenCalledOnce());
    // errorByCode: "Request failed ({code})." — the structured code, not the
    // raw ApiError message, reaches the UI.
    expect(
      await screen.findByText(/dataset\.unsupported_type/),
    ).toBeInTheDocument();
  });
});
