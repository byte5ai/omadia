import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../../messages/en.json';
import { renderWithIntl } from '../../../_lib/test-utils';
import { InstallButton } from '../InstallButton';
import type { PluginGrantsView } from '../../../_lib/api';
import type { InstallJob } from '../../../_lib/storeTypes';

/**
 * #825 — the install wizard must keep working now that a completed install can
 * report `errored`.
 *
 * The server used to answer `active` for every install that reached the
 * registry, including the ones whose activation failed because the operator
 * skipped a grant. The wizard papered over that by re-reading the grants view
 * before showing the success toast — which is why the bug was invisible here
 * and cost two false FAILs in the C16 acceptance probe, where automation read
 * the job directly.
 *
 * Now that the job tells the truth, the wizard must not treat the new word as
 * an unknown state. Three things are pinned:
 *
 *  1. `errored` + a grant to ask for → the Permissions step, not an error and
 *     certainly not a success toast. This is the C16 flow the operator lands in
 *     after skipping the dialog, and it must be REACHABLE from the new state.
 *  2. `errored` with nothing to grant → the activation error, named. A plugin
 *     that is installed and not running may never render as success.
 *  3. `active` still succeeds. Without this the fix could be "never show
 *     success" and pass.
 */

const { mockCreate, mockConfigure, mockGrants } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockConfigure: vi.fn(),
  mockGrants: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock('../../../_lib/api', () => ({
  createInstallJob: mockCreate,
  configureInstallJob: mockConfigure,
  getPluginGrants: mockGrants,
  deleteUploadedPackage: vi.fn(),
  getInstalledPlugin: vi.fn(),
  installFromRegistry: vi.fn(),
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

const PLUGIN = '@test/activation-state';
const LEDGER = 'plg_test_activation_state_migrations';
const PATH_ONE = '/api/plugins/activation-state/hook';

function job(over: Partial<InstallJob> = {}): InstallJob {
  return {
    id: 'job-1',
    plugin_id: PLUGIN,
    plugin_version: '0.1.0',
    state: 'awaiting_config',
    current_step: '',
    error: null,
    // No fields: the form submits immediately, which keeps these tests about
    // the terminal branch rather than about form rendering.
    setup_schema: { fields: [] },
    activation_state: null,
    created_at: '2026-08-21T00:00:00.000Z',
    updated_at: '2026-08-21T00:00:00.000Z',
    ...over,
  };
}

function grantsView(over: Partial<PluginGrantsView> = {}): PluginGrantsView {
  return {
    id: PLUGIN,
    declared: {
      sql: { ledger: LEDGER },
      public_paths: [PATH_ONE],
      optional_requires: [],
    },
    granted: { sql: false, sql_ledger: null, public_paths: [] },
    state: 'errored',
    missing: [
      { kind: 'sql', ledger: LEDGER },
      { kind: 'public_path', path: PATH_ONE },
    ],
    orphaned_public_paths: [],
    last_activation_error: 'sql permission not granted',
    last_activation_error_at: '2026-08-21T00:00:00.000Z',
    ...over,
  };
}

function renderButton(): void {
  renderWithIntl(
    <InstallButton
      pluginId={PLUGIN}
      pluginName="Activation State Fixture"
      installState="available"
      enabled
      blockingReasons={[]}
    />,
  );
}

/** Open the drawer and submit the (empty) setup form. */
async function installAndSubmit(): Promise<void> {
  fireEvent.click(
    screen.getByRole('button', { name: new RegExp(en.store.install.installAria.replace('{name}', '.*'), 'i') }),
  );
  const submit = await screen.findByRole('button', {
    name: new RegExp(en.store.install.confirmInstall, 'i'),
  });
  fireEvent.click(submit);
}

beforeEach(() => {
  mockCreate.mockReset();
  mockConfigure.mockReset();
  mockGrants.mockReset();
  mockCreate.mockResolvedValue({ job: job() });
});

void describe('#825 — the wizard handles the new errored job state', () => {
  void it('lands on the Permissions step when activation failed on a missing grant', async () => {
    mockConfigure.mockResolvedValue({
      job: job({
        state: 'errored',
        activation_state: {
          state: 'errored',
          ok: false,
          error: 'sql permission not granted',
          missing: [
            { kind: 'sql', ledger: LEDGER },
            { kind: 'public_path', path: PATH_ONE },
          ],
        },
      }),
      agent_id: PLUGIN,
    });
    mockGrants.mockResolvedValue(grantsView());

    renderButton();
    await installAndSubmit();

    // The permissions step names the ledger the plugin wants. Asserting on the
    // rendered declaration rather than on a heading keeps this test pinned to
    // the step being REACHED, not to its copy.
    await waitFor(() => {
      expect(screen.getByText(new RegExp(LEDGER))).toBeTruthy();
    });
    // The lie #825 removed must not come back through the UI.
    expect(screen.queryByText(new RegExp(en.store.install.success, 'i'))).toBeNull();
  });

  void it('does not show the success toast for an errored job with nothing to grant', async () => {
    mockConfigure.mockResolvedValue({
      job: job({
        state: 'errored',
        activation_state: {
          state: 'errored',
          ok: false,
          error: 'boom: the plugin threw on activate',
          missing: [],
        },
      }),
      agent_id: PLUGIN,
    });
    // Nothing declared → `hasGrantsToAsk` is false → there is no consent screen
    // to offer, and the honest answer is the activation error.
    mockGrants.mockResolvedValue(
      grantsView({
        declared: { sql: null, public_paths: [], optional_requires: [] },
        missing: [],
      }),
    );

    renderButton();
    await installAndSubmit();

    await waitFor(() => {
      expect(screen.getByText(/boom: the plugin threw on activate/)).toBeTruthy();
    });
    expect(screen.queryByText(new RegExp(en.store.install.success, 'i'))).toBeNull();
    // It must not be reported as an UNKNOWN state either — that is what the
    // wizard would have done before this branch existed, and it would have hidden
    // an actionable message behind "Unexpected job state: errored".
    expect(screen.queryByText(/Unexpected job state/i)).toBeNull();
  });

  void it('still shows success for an active job with nothing to grant', async () => {
    mockConfigure.mockResolvedValue({
      job: job({
        state: 'active',
        activation_state: { state: 'active', ok: true, error: null, missing: [] },
      }),
      agent_id: PLUGIN,
    });
    mockGrants.mockResolvedValue(
      grantsView({
        declared: { sql: null, public_paths: [], optional_requires: [] },
        granted: { sql: false, sql_ledger: null, public_paths: [] },
        state: 'active',
        missing: [],
        last_activation_error: null,
      }),
    );

    renderButton();
    await installAndSubmit();

    await waitFor(() => {
      expect(screen.getByText(new RegExp(en.store.install.success, 'i'))).toBeTruthy();
    });
  });

  void it('still offers the Permissions step for an ACTIVE job that has ungranted declarations', async () => {
    // A plugin can come up while an optional permission stays unanswered. The
    // pre-#825 behaviour, preserved: the state word decides success vs error,
    // the DECLARATION decides whether we ask.
    mockConfigure.mockResolvedValue({
      job: job({
        state: 'active',
        activation_state: { state: 'active', ok: true, error: null, missing: [] },
      }),
      agent_id: PLUGIN,
    });
    mockGrants.mockResolvedValue(grantsView({ state: 'active' }));

    renderButton();
    await installAndSubmit();

    await waitFor(() => {
      expect(screen.getByText(new RegExp(LEDGER))).toBeTruthy();
    });
  });
});
