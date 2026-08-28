import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../../messages/en.json';
import { renderWithIntl } from '../../../_lib/test-utils';
import { GrantsPanel } from '../GrantsPanel';
import { PermissionsStep } from '../PermissionsStep';
import type { PluginGrantsView } from '../../../_lib/api';

/**
 * Epic #470 C16 (#817) — the operator consent surface.
 *
 * The three properties worth pinning are the ones an operator's trust rests on:
 *
 *  1. The wizard SENDS what the boxes say, and sends the public paths as the
 *     complete set — a partial send would silently revoke.
 *  2. Both surfaces report the state the SERVER came back with, including
 *     `errored`. A UI that showed "saved" over a plugin that failed to restart
 *     would rebuild the exact lie #799 removed from the install path.
 *  3. A refusal renders as localized help, not as a raw machine code — the
 *     `runtime.sql_not_declared` case is the one an operator hits by unticking
 *     and re-ticking on a plugin whose manifest changed under them.
 */

const { mockGet, mockSet } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSet: vi.fn(),
}));

vi.mock('../../../_lib/api', () => ({
  getPluginGrants: mockGet,
  setPluginGrants: mockSet,
  ApiError: class ApiError extends Error {
    public readonly code: string | null;
    constructor(
      public status: number,
      message: string,
      public body: string = '',
    ) {
      super(message);
      this.name = 'ApiError';
      try {
        const parsed = JSON.parse(body) as { code?: unknown };
        this.code = typeof parsed.code === 'string' ? parsed.code : null;
      } catch {
        this.code = null;
      }
    }
  },
}));

const PLUGIN = '@test/grants';
const LEDGER = 'plg_test_grants_migrations';
const P_ONE = '/api/plugins/test-grants/hook';
const P_TWO = '/api/plugins/test-grants/callback';

function view(over: Partial<PluginGrantsView> = {}): PluginGrantsView {
  return {
    id: PLUGIN,
    declared: {
      sql: { ledger: LEDGER },
      public_paths: [P_ONE, P_TWO],
      optional_requires: [],
    },
    granted: { sql: false, sql_ledger: null, public_paths: [] },
    state: 'errored',
    missing: [
      { kind: 'sql', ledger: LEDGER },
      { kind: 'public_path', path: P_ONE },
      { kind: 'public_path', path: P_TWO },
    ],
    orphaned_public_paths: [],
    last_activation_error: null,
    last_activation_error_at: null,
    ...over,
  };
}

beforeEach(() => {
  mockGet.mockReset();
  mockSet.mockReset();
});

// ── the install wizard step ────────────────────────────────────────────────

describe('#470 C16 — install wizard permissions step', () => {
  it('renders one row per declared grant, all ticked', () => {
    renderWithIntl(<PermissionsStep grants={view()} onFinish={vi.fn()} />);

    expect(screen.getByTestId('permissions-step')).toBeTruthy();
    expect(
      screen.getByText(en.store.grants.sqlTitle, { selector: 'span' }),
    ).toBeTruthy();
    // The ledger name is shown, because "owns its own tables" is not a claim an
    // operator can check without knowing WHICH table.
    expect(screen.getByText(`Migration ledger: ${LEDGER}`)).toBeTruthy();

    for (const path of [P_ONE, P_TWO]) {
      const box = screen.getByLabelText(path) as HTMLInputElement;
      expect(box.checked).toBe(true);
    }
    const sqlBox = screen.getByLabelText(
      en.store.grants.sqlTitle,
    ) as HTMLInputElement;
    expect(sqlBox.checked).toBe(true);
  });

  it('sends exactly what the boxes say, public paths as the complete set', async () => {
    mockSet.mockResolvedValue(
      view({
        granted: { sql: true, sql_ledger: LEDGER, public_paths: [P_TWO] },
        state: 'active',
        missing: [{ kind: 'public_path', path: P_ONE }],
      }),
    );
    renderWithIntl(<PermissionsStep grants={view()} onFinish={vi.fn()} />);

    // Operator declines ONE of the two public paths.
    fireEvent.click(screen.getByLabelText(P_ONE));
    fireEvent.click(
      screen.getByRole('button', { name: en.store.grants.grantAndActivate }),
    );

    await waitFor(() => {
      expect(mockSet).toHaveBeenCalledTimes(1);
    });
    expect(mockSet).toHaveBeenCalledWith(PLUGIN, {
      sql: true,
      public_paths: [P_TWO],
    });
  });

  it('shows the state the server came back with, not "saved"', async () => {
    // The grant was written and the plugin STILL did not come up. The step must
    // say so — this is the #799 property, restated on the consent surface.
    mockSet.mockResolvedValue(
      view({
        granted: { sql: true, sql_ledger: LEDGER, public_paths: [P_ONE, P_TWO] },
        state: 'errored',
        missing: [],
        last_activation_error: 'connect ECONNREFUSED 127.0.0.1:5432',
      }),
    );
    renderWithIntl(<PermissionsStep grants={view()} onFinish={vi.fn()} />);

    fireEvent.click(
      screen.getByRole('button', { name: en.store.grants.grantAndActivate }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('permissions-result')).toBeTruthy();
    });
    expect(screen.getByText(en.store.grants.state.errored)).toBeTruthy();
    // The server's own sentence rides along as the detail.
    expect(
      screen.getByText('connect ECONNREFUSED 127.0.0.1:5432'),
    ).toBeTruthy();
  });

  it('skip grants nothing and asks the server what that means', async () => {
    mockGet.mockResolvedValue(view({ state: 'errored' }));
    renderWithIntl(<PermissionsStep grants={view()} onFinish={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: en.store.grants.skip }));

    await waitFor(() => {
      expect(screen.getByTestId('permissions-result')).toBeTruthy();
    });
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockGet).toHaveBeenCalledWith(PLUGIN);
    expect(screen.getByText(en.store.grants.skippedBody)).toBeTruthy();
    // The way back in, so skipping is not a dead end.
    expect(
      screen.getByRole('link', { name: en.store.grants.openPanel }),
    ).toBeTruthy();
  });

  it('renders a refusal as localized help, never as a raw code', async () => {
    const { ApiError } = await import('../../../_lib/api');
    mockSet.mockRejectedValue(
      new (ApiError as unknown as new (
        s: number,
        m: string,
        b: string,
      ) => Error)(
        400,
        'PUT failed',
        JSON.stringify({
          code: 'runtime.sql_not_declared',
          message: 'agent does not declare permissions.sql',
        }),
      ),
    );
    renderWithIntl(<PermissionsStep grants={view()} onFinish={vi.fn()} />);

    fireEvent.click(
      screen.getByRole('button', { name: en.store.grants.grantAndActivate }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(en.errorHelp.runtime.sql_not_declared.what),
      ).toBeTruthy();
    });
    // The raw body is not absent — `ErrorHelp` keeps it in a collapsed support
    // disclosure on purpose. The property under test is that it is never the
    // headline: no <p> on screen carries the machine code.
    expect(
      screen.queryByText(/runtime\.sql_not_declared/, { selector: 'p' }),
    ).toBeNull();
    expect(
      screen.getByText(/runtime\.sql_not_declared/, { selector: 'pre' }),
    ).toBeTruthy();
  });
});

// ── the detail-page panel ──────────────────────────────────────────────────

describe('#470 C16 — plugin detail grants panel', () => {
  it('starts from what is granted, not from what is declared', async () => {
    mockGet.mockResolvedValue(
      view({
        granted: { sql: false, sql_ledger: null, public_paths: [P_ONE] },
        state: 'errored',
      }),
    );
    renderWithIntl(<GrantsPanel pluginId={PLUGIN} />);

    await waitFor(() => {
      expect(screen.getByTestId('grants-panel')).toBeTruthy();
    });
    // Granted → ticked. Declined → unticked. Pre-ticking the declined one would
    // misreport the system's state to the person who has to trust it.
    expect((screen.getByLabelText(P_ONE) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByLabelText(P_TWO) as HTMLInputElement).checked).toBe(
      false,
    );
    expect(
      (screen.getByLabelText(en.store.grants.sqlTitle) as HTMLInputElement)
        .checked,
    ).toBe(false);
  });

  it('grants a previously skipped permission through the same route', async () => {
    mockGet.mockResolvedValue(view());
    mockSet.mockResolvedValue(
      view({
        granted: { sql: true, sql_ledger: LEDGER, public_paths: [] },
        state: 'active',
        missing: [
          { kind: 'public_path', path: P_ONE },
          { kind: 'public_path', path: P_TWO },
        ],
      }),
    );
    renderWithIntl(<GrantsPanel pluginId={PLUGIN} />);

    await waitFor(() => {
      expect(screen.getByTestId('grants-panel')).toBeTruthy();
    });
    fireEvent.click(screen.getByLabelText(en.store.grants.sqlTitle));
    fireEvent.click(screen.getByRole('button', { name: en.store.grants.apply }));

    await waitFor(() => {
      expect(mockSet).toHaveBeenCalledWith(PLUGIN, {
        sql: true,
        public_paths: [],
      });
    });
    expect(screen.getByText(en.store.grants.state.active)).toBeTruthy();
  });

  it('names a grant left over for a ledger the manifest no longer declares', async () => {
    mockGet.mockResolvedValue(
      view({
        granted: {
          sql: false,
          sql_ledger: 'plg_test_grants_old',
          public_paths: [],
        },
      }),
    );
    renderWithIntl(<GrantsPanel pluginId={PLUGIN} />);

    await waitFor(() => {
      expect(screen.getByTestId('grants-panel')).toBeTruthy();
    });
    expect(
      screen.getByText(/plg_test_grants_old/, { selector: 'span' }),
    ).toBeTruthy();
  });

  it('omits public_paths entirely when the manifest declares none', async () => {
    // `[]` would mean "revoke everything", which is a different statement from
    // "this plugin has none" — and on a plugin with no declaration it would be
    // a write with nothing to write.
    mockGet.mockResolvedValue(
      view({
        declared: {
          sql: { ledger: LEDGER },
          public_paths: [],
          optional_requires: [],
        },
        missing: [{ kind: 'sql', ledger: LEDGER }],
      }),
    );
    mockSet.mockResolvedValue(
      view({
        declared: {
          sql: { ledger: LEDGER },
          public_paths: [],
          optional_requires: [],
        },
        granted: { sql: true, sql_ledger: LEDGER, public_paths: [] },
        state: 'active',
        missing: [],
      }),
    );
    renderWithIntl(<GrantsPanel pluginId={PLUGIN} />);

    await waitFor(() => {
      expect(screen.getByTestId('grants-panel')).toBeTruthy();
    });
    fireEvent.click(screen.getByLabelText(en.store.grants.sqlTitle));
    fireEvent.click(screen.getByRole('button', { name: en.store.grants.apply }));

    await waitFor(() => {
      expect(mockSet).toHaveBeenCalledWith(PLUGIN, { sql: true });
    });
  });

  it('offers an Apply that clears a grant the manifest no longer asks for', async () => {
    // The `orphaned` line promises that applying this form clears them. When
    // the plugin declares no public path at all, the panel used to take the
    // "nothing to consent to" branch — no Apply button — and `save()` omitted
    // `public_paths` anyway, so the promise was false in exactly the case that
    // produces orphans most often: a plugin that DROPPED its declaration.
    const orphaned = view({
      declared: { sql: null, public_paths: [], optional_requires: [] },
      granted: { sql: false, sql_ledger: null, public_paths: [] },
      orphaned_public_paths: [P_ONE],
      missing: [],
      state: 'active',
    });
    mockGet.mockResolvedValue(orphaned);
    mockSet.mockResolvedValue({ ...orphaned, orphaned_public_paths: [] });
    renderWithIntl(<GrantsPanel pluginId={PLUGIN} />);

    await waitFor(() => {
      expect(screen.getByTestId('grants-panel')).toBeTruthy();
    });
    // The orphan is named, and there is something to press.
    expect(
      screen.getByText(
        en.store.grants.orphaned.replace('{paths}', P_ONE),
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en.store.grants.apply }));

    // `[]` is the whole point: it is the statement "nothing is consented",
    // which is the only thing that clears the leftover row.
    await waitFor(() => {
      expect(mockSet).toHaveBeenCalledWith(PLUGIN, { public_paths: [] });
    });
  });

  it('says so plainly when the plugin asks for nothing', async () => {
    mockGet.mockResolvedValue(
      view({
        declared: { sql: null, public_paths: [], optional_requires: [] },
        missing: [],
        state: 'active',
      }),
    );
    renderWithIntl(<GrantsPanel pluginId={PLUGIN} />);

    await waitFor(() => {
      expect(screen.getByText(en.store.grants.nothingDeclared)).toBeTruthy();
    });
  });

  it('lists optional prerequisites without offering them as grants', async () => {
    mockGet.mockResolvedValue(
      view({
        declared: {
          sql: null,
          public_paths: [],
          optional_requires: ['embeddings@^1'],
        },
        missing: [],
        state: 'active',
      }),
    );
    renderWithIntl(<GrantsPanel pluginId={PLUGIN} />);

    await waitFor(() => {
      expect(screen.getByTestId('grants-panel')).toBeTruthy();
    });
    expect(screen.getByText('embeddings@^1')).toBeTruthy();
    // Nothing to consent to: no checkbox may appear for it.
    expect(screen.queryByLabelText('embeddings@^1')).toBeNull();
  });
});
