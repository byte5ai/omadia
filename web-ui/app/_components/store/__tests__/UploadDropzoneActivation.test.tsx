import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { UploadDropzone } from '../UploadDropzone';
import type { UploadedPackage } from '../../../_lib/storeTypes';

/**
 * #1452 — the ZIP re-upload named in the issue title. A re-upload onto a
 * running plugin re-activates it; when that activation throws, the middleware
 * answers the 201 with `activation_error` and has flipped the registry entry to
 * `errored`. The upload panel reported plain success, so the operator saw
 * "in catalog" over a plugin that had just stopped serving.
 */

const { mockUploadPackage } = vi.hoisted(() => ({ mockUploadPackage: vi.fn() }));

vi.mock('../../../_lib/api', () => ({
  uploadPackage: mockUploadPackage,
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public body: string = '',
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const ACTIVATION_ERROR =
  "plugin '@test/zip' called ctx.services.get('entityRefBus') but its manifest does not declare that capability";

function pkg(): UploadedPackage {
  return {
    id: '@test/zip',
    version: '0.2.0',
    path: '/data/.uploaded-packages/@test/zip/0.2.0',
    uploaded_at: '2026-10-26T00:00:00.000Z',
    uploaded_by: 'op@example.com',
    sha256: 'a'.repeat(64),
    peers_missing: [],
    zip_bytes: 2048,
    extracted_bytes: 8192,
    file_count: 7,
  };
}

/** Feed a .zip through the hidden file input the dropzone renders. */
function upload(): void {
  const input = document.querySelector('input[type="file"]');
  expect(input).toBeTruthy();
  const file = new File(['PK'], 'zip-plugin.zip', { type: 'application/zip' });
  fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
}

beforeEach(() => {
  mockUploadPackage.mockReset();
});

void describe('#1452 — the upload panel reports a failed re-activation', () => {
  void it('names the activation error on an otherwise successful upload', async () => {
    mockUploadPackage.mockResolvedValue({ package: pkg(), activation_error: ACTIVATION_ERROR });

    renderWithIntl(<UploadDropzone />);
    upload();

    await waitFor(() => {
      expect(screen.getByText(new RegExp('entityRefBus'))).toBeTruthy();
    });
  });

  void it('shows no such warning when the plugin restarted', async () => {
    mockUploadPackage.mockResolvedValue({ package: pkg() });

    renderWithIntl(<UploadDropzone />);
    upload();

    await waitFor(() => {
      expect(screen.getByText(new RegExp('@test/zip'))).toBeTruthy();
    });
    expect(screen.queryByText(new RegExp('did not restart', 'i'))).toBeNull();
  });
});
