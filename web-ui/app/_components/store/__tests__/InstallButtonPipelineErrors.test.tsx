import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../../messages/en.json';
import { renderWithIntl } from '../../../_lib/test-utils';
import { InstallButton } from '../InstallButton';
import type { InstallJob } from '../../../_lib/storeTypes';

/**
 * Sweep 2 / N02 — the install drawer's dead ends.
 *
 *  - #1494: a server-side validation failure used to END the job, so the
 *    corrected submit got 409 `install.wrong_state`. The job now stays
 *    `awaiting_config`, and the drawer resubmits to it.
 *  - #1495: closing the drawer or the wizard did not refresh the page, so the
 *    second "Install now" ran on stale props; and the Hub fetch now asks for
 *    the version the page shows.
 *  - #1477: Hub-install refusals come with the upload's `code` + `params` and
 *    are shown in the UI locale, not as the server's German text.
 *  - #1490: an uploaded, not installed package can be removed here.
 */

const { mockCreate, mockConfigure, mockGrants, mockRegistry, mockDelete, refresh, push } =
  vi.hoisted(() => ({
    mockCreate: vi.fn(),
    mockConfigure: vi.fn(),
    mockGrants: vi.fn(),
    mockRegistry: vi.fn(),
    mockDelete: vi.fn(),
    refresh: vi.fn(),
    push: vi.fn(),
  }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push }),
}));

vi.mock('../../../_lib/api', () => ({
  createInstallJob: mockCreate,
  configureInstallJob: mockConfigure,
  getPluginGrants: mockGrants,
  deleteUploadedPackage: mockDelete,
  getInstalledPlugin: vi.fn(),
  installFromRegistry: mockRegistry,
  uninstallPlugin: vi.fn(),
  updateInstalledPluginConfig: vi.fn(),
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

// The mocked module's ApiError, so `instanceof` in the component matches.
const { ApiError } = (await import('../../../_lib/api')) as unknown as {
  ApiError: new (status: number, message: string, body?: string) => Error;
};

const PLUGIN = '@test/pipeline';

function job(over: Partial<InstallJob> = {}): InstallJob {
  return {
    id: 'job-1',
    plugin_id: PLUGIN,
    plugin_version: '0.2.8',
    state: 'awaiting_config',
    current_step: '',
    error: null,
    setup_schema: { fields: [] },
    activation_state: null,
    created_at: '2026-10-28T00:00:00.000Z',
    updated_at: '2026-10-28T00:00:00.000Z',
    ...over,
  };
}

function renderButton(over: Partial<Parameters<typeof InstallButton>[0]> = {}): void {
  renderWithIntl(
    <InstallButton
      pluginId={PLUGIN}
      pluginName="Pipeline Fixture"
      installState="available"
      enabled
      blockingReasons={[]}
      installedVersion="0.2.8"
      {...over}
    />,
  );
}

function clickInstall(): void {
  fireEvent.click(
    screen.getByRole('button', {
      name: new RegExp(en.store.install.installAria.replace('{name}', '.*'), 'i'),
    }),
  );
}

async function submit(): Promise<void> {
  fireEvent.click(
    await screen.findByRole('button', { name: new RegExp(en.store.install.confirmInstall, 'i') }),
  );
}

beforeEach(() => {
  for (const m of [mockCreate, mockConfigure, mockGrants, mockRegistry, mockDelete, refresh, push]) {
    m.mockReset();
  }
  mockCreate.mockResolvedValue({ job: job() });
  mockGrants.mockResolvedValue(null);
});

describe('#1494 — a rejected submit can be corrected on the same job', () => {
  it('keeps the form after awaiting_config + error, and the next submit installs', async () => {
    mockConfigure
      .mockResolvedValueOnce({
        job: job({
          error: {
            code: 'install.validation_failed',
            message: 'Eingaben enthalten Fehler',
            details: [{ key: 'sa_key_file', message: 'wrong file kind' }],
          },
        }),
        agent_id: PLUGIN,
      })
      .mockResolvedValueOnce({ job: job({ state: 'active' }), agent_id: PLUGIN });

    renderButton();
    clickInstall();
    await submit();
    await waitFor(() => expect(mockConfigure).toHaveBeenCalledTimes(1));
    await submit();

    await waitFor(() => expect(mockConfigure).toHaveBeenCalledTimes(2));
    // Same job both times — no new job, no wrong_state.
    expect(mockConfigure.mock.calls[1]![0]).toBe('job-1');
    await waitFor(() =>
      expect(screen.getAllByText(new RegExp(en.store.install.success, 'i')).length).toBeGreaterThan(0),
    );
  });

  it('a 409 wrong_state shows the localized help and no resubmittable form', async () => {
    mockConfigure.mockRejectedValue(
      new ApiError(
        409,
        'configure failed: 409',
        JSON.stringify({
          code: 'install.wrong_state',
          message: "job is in state 'failed', expected 'awaiting_config'",
        }),
      ),
    );

    renderButton();
    clickInstall();
    await submit();

    await waitFor(() =>
      expect(screen.getByText(new RegExp(en.errorHelp.install.wrong_state.what))).toBeTruthy(),
    );
    expect(screen.queryByText(/expected 'awaiting_config'/)).toBeNull();
    expect(
      screen.queryByRole('button', { name: new RegExp(en.store.install.confirmInstall, 'i') }),
    ).toBeNull();
  });
});

describe('#1495 / #1477 — Hub install from the detail page', () => {
  it('asks the Hub for the version the page shows', async () => {
    mockRegistry.mockResolvedValue({ ok: true, plugin_id: PLUGIN, version: '0.2.8', registry: 'r', next: { install: '' } });
    renderButton({ remote: true });
    clickInstall();
    await waitFor(() => expect(mockRegistry).toHaveBeenCalledWith(PLUGIN, '0.2.8'));
  });

  it('shows a Hub refusal in the UI locale, from code + params', async () => {
    mockRegistry.mockRejectedValue(
      new ApiError(
        409,
        'POST failed: 409',
        JSON.stringify({
          code: 'package.duplicate_version',
          message: `Version 0.2.8 von ${PLUGIN} ist bereits hochgeladen.`,
          params: { pluginId: PLUGIN, version: '0.2.8' },
        }),
      ),
    );
    renderButton({ remote: true });
    clickInstall();
    await waitFor(() =>
      expect(screen.getByText(new RegExp(`Version 0\\.2\\.8 of ${PLUGIN} is already uploaded`))).toBeTruthy(),
    );
    expect(screen.queryByText(/ist bereits hochgeladen/)).toBeNull();
  });

  it('refreshes the page when the drawer closes after a failed step', async () => {
    mockRegistry.mockRejectedValue(new ApiError(502, 'POST failed: 502', ''));
    renderButton({ remote: true });
    clickInstall();
    const close = await screen.findByText(en.store.install.close);
    fireEvent.click(close);
    expect(refresh).toHaveBeenCalled();
  });
});

describe('#1490 — remove an uploaded, not installed package', () => {
  it('is offered only when the store flags the package removable', () => {
    renderButton();
    expect(screen.queryByText(en.store.install.removePackage)).toBeNull();
  });

  it('removes after confirmation and goes back to the store', async () => {
    mockDelete.mockResolvedValue(undefined);
    renderButton({ removablePackage: true });
    fireEvent.click(screen.getByText(en.store.install.removePackage));
    fireEvent.click(await screen.findByText(en.store.install.removePackageYes));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith(PLUGIN));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/store'));
  });
});
