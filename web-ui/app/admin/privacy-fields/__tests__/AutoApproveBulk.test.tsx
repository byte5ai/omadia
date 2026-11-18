import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  FieldBulkPreview,
  FieldClassificationItem,
  FieldClassificationList,
} from '../../../_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import { actionLabelKey, actionsFor } from '../_components/FieldCard';
import { PrivacyFieldsView } from '../_components/PrivacyFieldsView';

/**
 * Auto-approve + bulk accept on /admin/privacy-fields: the auto_* status
 * tabs and cards, the "Accept suggestions" dialog fed by bulk/preview, the
 * confirm body, localized skip reasons, per-group accept and undo of the
 * latest bulk action. Requests are routed by method + path.
 */

const BASE = '/bot-api/v1/admin/privacy/field-classification';

function item(over: Partial<FieldClassificationItem> = {}): FieldClassificationItem {
  return {
    id: 'f1',
    toolName: 'odoo_execute',
    fieldPath: 'department_id',
    valueShape: 'm2o',
    scope: 'hr.employee',
    label: 'Department',
    relationModels: ['hr.department'],
    status: 'suggested',
    reasons: [{ code: 'known_non_personal', models: ['hr.department'] }],
    configEntry: 'odoo_execute:hr.employee/department_id',
    fingerprint: 'fp-1',
    decision: null,
    firstSeenAt: '2026-10-29T08:00:00.000Z',
    lastSeenAt: '2026-10-30T08:00:00.000Z',
    seenCount: 12,
    ...over,
  };
}

function list(items: FieldClassificationItem[], suggested = 2): FieldClassificationList {
  return {
    items,
    counts: {
      suggested,
      needs_clarification: 0,
      personal: 0,
      confirmed: 0,
      confirmed_conflict: 0,
      rejected: 0,
      kept_masked: 0,
      auto_approved: 5,
      auto_revoked: 1,
    },
    newSinceLastVisit: 0,
    computedAt: '2026-10-30T09:15:00.000Z',
  };
}

const PREVIEW: FieldBulkPreview = {
  count: 2,
  byReason: { known_non_personal: 1, haiku: 1 },
  byTool: { odoo_execute: 2 },
  items: [
    {
      id: 'f1',
      toolName: 'odoo_execute',
      scope: 'hr.employee',
      fieldPath: 'department_id',
      entry: 'odoo_execute:hr.employee/department_id',
      reasonCode: 'known_non_personal',
    },
    {
      id: 'f2',
      toolName: 'odoo_execute',
      scope: 'crm.lead',
      fieldPath: 'stage_id',
      entry: 'odoo_execute:crm.lead/stage_id',
      reasonCode: 'haiku',
    },
  ],
};

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Route = (url: URL, init: RequestInit | undefined) => Response | undefined;

const calls: { url: URL; init: RequestInit | undefined }[] = [];
let routes: Route[] = [];

function on(method: string, path: string, ...bodies: [unknown, number?][]): void {
  const queue = [...bodies];
  routes.push((url, init) => {
    if ((init?.method ?? 'GET') !== method || url.pathname !== path) return undefined;
    const [body, status] = queue.length > 1 ? queue.shift()! : queue[0]!;
    return respond(body, status ?? 200);
  });
}

function callsTo(method: string, path: string): { url: URL; init: RequestInit | undefined }[] {
  return calls.filter((c) => (c.init?.method ?? 'GET') === method && c.url.pathname === path);
}

beforeEach(() => {
  calls.length = 0;
  routes = [];
  vi.stubGlobal('fetch', (raw: string, init?: RequestInit) => {
    const url = new URL(raw, 'http://localhost');
    calls.push({ url, init });
    for (const route of routes) {
      const res = route(url, init);
      if (res) return Promise.resolve(res);
    }
    return Promise.resolve(respond({ error: 'unrouted' }, 500));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('auto-approval statuses', () => {
  it('renders the new tabs with counts and the auto-approved card (en)', async () => {
    on('GET', `${BASE}/bulk/latest`, [null]);
    on('GET', BASE, [
      list([
        item({
          status: 'auto_approved',
          reasons: [
            { code: 'auto_approved', basis: 'haiku', confidence: 0.93 },
            { code: 'haiku_non_personal', model: 'x_custom.region', confidence: 0.93 },
            { code: 'sample_clean', sampleCount: 4 },
          ],
          decision: { action: 'auto_approve', by: 'system:auto-classifier', at: '2026-10-31T07:00:00.000Z' },
        }),
      ]),
    ]);
    renderWithIntl(<PrivacyFieldsView status="auto_approved" tool={null} />);

    const card = await screen.findByTestId('field-f1');
    expect(screen.getByTestId('tab-auto_approved')).toHaveTextContent('Auto-approved5');
    expect(screen.getByTestId('tab-auto_approved').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('tab-auto_revoked')).toHaveTextContent('Auto-approval revoked1');
    expect(within(card).getByTestId('field-status')).toHaveTextContent('Auto-approved');
    expect(
      within(card).getByText(/rated the target non-personal \(93% confidence\) and the name check/),
    ).toBeInTheDocument();
    expect(within(card).getByTestId('field-decision')).toHaveTextContent(
      'Auto-approved by the system (auto-classifier) on',
    );
    expect(within(card).getByRole('button', { name: 'Revert' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Confirm as admin decision' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('renders the known-model basis, the revoked card and German labels', async () => {
    on('GET', `${BASE}/bulk/latest`, [null]);
    on('GET', BASE, [
      list([
        item({
          status: 'auto_revoked',
          reasons: [{ code: 'auto_revoked' }, { code: 'person_model', models: ['res.partner'] }],
          decision: { action: 'auto_revoke', by: 'system:auto-classifier', at: '2026-10-31T07:00:00.000Z' },
        }),
        item({
          id: 'f2',
          status: 'auto_approved',
          reasons: [{ code: 'auto_approved', basis: 'known_non_personal' }],
        }),
      ]),
    ]);
    renderWithIntl(<PrivacyFieldsView status="auto_revoked" tool={null} />, { locale: 'de' });

    const revoked = await screen.findByTestId('field-f1');
    expect(screen.getByTestId('tab-auto_approved')).toHaveTextContent('Automatisch freigegeben');
    expect(screen.getByTestId('tab-auto_revoked')).toHaveTextContent('Automatik zurückgenommen');
    expect(within(revoked).getByText(/Die automatische Freigabe wurde zurückgenommen/)).toBeInTheDocument();
    expect(within(revoked).getByTestId('field-decision')).toHaveTextContent(
      'Automatische Freigabe zurückgenommen von dem System (Auto-Klassifizierer) am',
    );
    for (const name of ['Bestätigen', 'Maskiert lassen', 'Ablehnen']) {
      expect(within(revoked).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(
      within(screen.getByTestId('field-f2')).getByText(
        'Automatisch freigegeben durch den Auto-Klassifizierer: Jedes Relationsziel ist ein bekanntes nicht-personenbezogenes Modell.',
      ),
    ).toBeInTheDocument();
  });

  it('maps actions per status', () => {
    expect(actionsFor('auto_approved')).toEqual(['revert', 'confirm']);
    expect(actionsFor('auto_revoked')).toEqual(['confirm', 'keep_masked', 'reject']);
    expect(actionLabelKey('auto_approved', 'confirm')).toBe('actions.takeOwnership');
    expect(actionLabelKey('auto_revoked', 'confirm')).toBe('actions.confirm');
  });

  it('revert on an auto-approved field posts its fingerprint', async () => {
    on('GET', `${BASE}/bulk/latest`, [null]);
    on('GET', BASE, [list([item({ status: 'auto_approved' })])], [list([])]);
    on('POST', `${BASE}/f1/decision`, [{ item: item({ status: 'confirmed' }) }]);
    renderWithIntl(<PrivacyFieldsView status="auto_approved" tool={null} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Revert' }));
    await waitFor(() => expect(callsTo('POST', `${BASE}/f1/decision`)).toHaveLength(1));
    expect(JSON.parse(String(callsTo('POST', `${BASE}/f1/decision`)[0]!.init?.body))).toEqual({
      action: 'revert',
      fingerprint: 'fp-1',
    });
  });
});

describe('accept suggestions', () => {
  it('is disabled without open suggestions', async () => {
    on('GET', `${BASE}/bulk/latest`, [null]);
    on('GET', BASE, [list([], 0)]);
    renderWithIntl(<PrivacyFieldsView status="suggested" tool={null} />);
    await screen.findByText('No fields with this status.');
    expect(screen.getByTestId('bulk-accept')).toBeDisabled();
  });

  it('opens an accessible dialog from the preview and confirms the listed ids', async () => {
    on('GET', `${BASE}/bulk/latest`, [null], [{ id: 'b1', createdAt: '2026-10-31T08:00:00.000Z', count: 1 }]);
    on('GET', BASE, [list([item()])], [list([], 0)]);
    on('GET', `${BASE}/bulk/preview`, [PREVIEW]);
    on('POST', `${BASE}/bulk/confirm`, [
      {
        batchId: 'b1',
        applied: [PREVIEW.items[0]],
        skipped: [{ id: 'f2', reason: 'detector_hit' }],
      },
    ]);
    renderWithIntl(<PrivacyFieldsView status="suggested" tool={null} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Accept suggestions' }));
    const dialog = await screen.findByRole('dialog', { name: 'Accept suggestions' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await within(dialog).findByTestId('bulk-count');
    expect(within(dialog).getByTestId('bulk-count')).toHaveTextContent('2 fields will be accepted');
    expect(within(dialog).getByTestId('bulk-by-reason')).toHaveTextContent('Known non-personal model: 1');
    expect(within(dialog).getByTestId('bulk-by-reason')).toHaveTextContent('Schema review (Haiku): 1');
    expect(within(dialog).getByTestId('bulk-by-tool')).toHaveTextContent('odoo_execute: 2');
    const fields = within(dialog).getByTestId('bulk-field-list');
    expect(fields).toHaveTextContent('odoo_execute:hr.employee/department_id');
    expect(fields).toHaveTextContent('odoo_execute:crm.lead/stage_id');
    expect(callsTo('GET', `${BASE}/bulk/preview`)[0]!.url.searchParams.get('status')).toBe('suggested');
    // Focus opens on Cancel.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept 2 fields' }));

    const result = await screen.findByTestId('bulk-result');
    expect(JSON.parse(String(callsTo('POST', `${BASE}/bulk/confirm`)[0]!.init?.body))).toEqual({
      ids: ['f1', 'f2'],
    });
    expect(result).toHaveTextContent('1 field accepted.');
    expect(result).toHaveTextContent('1 field skipped:');
    expect(within(result).getByTestId('bulk-skipped')).toHaveTextContent(
      'odoo_execute:crm.lead/stage_id: the detector found personal data',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    // The list and the undo offer are reloaded.
    expect(await screen.findByTestId('bulk-undo')).toHaveTextContent('Undo last bulk action');
  });

  it('confirms by filter when the preview does not list every field, with German skip reasons', async () => {
    on('GET', `${BASE}/bulk/latest`, [null]);
    on('GET', BASE, [list([item()])]);
    on('GET', `${BASE}/bulk/preview`, [{ ...PREVIEW, count: 3 }]);
    on('POST', `${BASE}/bulk/confirm`, [
      {
        batchId: 'b1',
        applied: [],
        skipped: [
          { id: 'f1', reason: 'stale' },
          { id: 'zz', reason: 'something_new' },
        ],
      },
    ]);
    renderWithIntl(<PrivacyFieldsView status="suggested" tool="odoo_execute" />, { locale: 'de' });

    fireEvent.click(await screen.findByRole('button', { name: 'Vorschläge übernehmen' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('1 weiteres Feld ist nicht aufgeführt.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '3 Felder übernehmen' }));

    const result = await screen.findByTestId('bulk-result');
    expect(JSON.parse(String(callsTo('POST', `${BASE}/bulk/confirm`)[0]!.init?.body))).toEqual({
      filter: { status: 'suggested', tool: 'odoo_execute' },
    });
    expect(result).toHaveTextContent('Kein Feld übernommen.');
    expect(result).toHaveTextContent('odoo_execute:hr.employee/department_id: seit der Vorschau geändert');
    expect(result).toHaveTextContent('zz: anderer Grund (something_new)');
  });

  it('the toolbar preview respects the active tool filter', async () => {
    on('GET', `${BASE}/bulk/latest`, [null]);
    on('GET', BASE, [list([item()])]);
    on('GET', `${BASE}/bulk/preview`, [PREVIEW]);
    renderWithIntl(<PrivacyFieldsView status="suggested" tool="odoo_execute" />);

    fireEvent.click(await screen.findByTestId('bulk-accept'));
    await screen.findByTestId('bulk-count');
    const { searchParams } = callsTo('GET', `${BASE}/bulk/preview`)[0]!.url;
    expect(searchParams.get('status')).toBe('suggested');
    expect(searchParams.get('tool')).toBe('odoo_execute');
  });

  it('per-group accept previews that tool only; Escape closes the dialog', async () => {
    on('GET', `${BASE}/bulk/latest`, [null]);
    on('GET', BASE, [
      list([item(), item({ id: 'f9', toolName: 'odoo_search_read', fieldPath: 'country_id' })]),
    ]);
    on('GET', `${BASE}/bulk/preview`, [PREVIEW]);
    renderWithIntl(<PrivacyFieldsView status="suggested" tool={null} />);

    const group = await screen.findByTestId('tool-odoo_search_read');
    fireEvent.click(within(group).getByRole('button', { name: 'Accept all suggestions of odoo_search_read' }));
    expect(await screen.findByRole('dialog', { name: 'Accept suggestions of odoo_search_read' })).toBeInTheDocument();
    await screen.findByTestId('bulk-count');
    expect(callsTo('GET', `${BASE}/bulk/preview`)[0]!.url.searchParams.get('tool')).toBe('odoo_search_read');

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(callsTo('POST', `${BASE}/bulk/confirm`)).toHaveLength(0);
  });

  it('a failed preview shows a localized error and disables confirm', async () => {
    on('GET', `${BASE}/bulk/latest`, [null]);
    on('GET', BASE, [list([item()])]);
    on('GET', `${BASE}/bulk/preview`, [{ error: 'boom', message: 'db down' }, 500]);
    renderWithIntl(<PrivacyFieldsView status="suggested" tool={null} />);

    fireEvent.click(await screen.findByTestId('bulk-accept'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('The suggestions to accept could not be loaded.')).toBeInTheDocument();
    expect(within(dialog).getByText('Technical detail: db down')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Accept' })).toBeDisabled();
  });
});

describe('undo last bulk action', () => {
  it('confirms, posts undo and shows the summary', async () => {
    on('GET', `${BASE}/bulk/latest`, [{ batch: { id: 'b7', createdAt: '2026-10-31T08:00:00.000Z', count: 2 } }], [{ batch: null }]);
    on('GET', BASE, [list([])]);
    on('POST', `${BASE}/bulk/b7/undo`, [
      {
        batchId: 'b7',
        reverted: [PREVIEW.items[0]],
        skipped: [{ id: 'f2', reason: 'not_present' }],
      },
    ]);
    renderWithIntl(<PrivacyFieldsView status="suggested" tool={null} />);

    fireEvent.click(await screen.findByTestId('bulk-undo'));
    const dialog = await screen.findByRole('dialog', { name: 'Undo the last bulk action?' });
    expect(dialog).toHaveTextContent('The 2 entries accepted on');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Undo' }));

    const summary = await screen.findByTestId('bulk-undo-result');
    expect(callsTo('POST', `${BASE}/bulk/b7/undo`)).toHaveLength(1);
    expect(summary).toHaveTextContent('1 entry removed — the field is masked again.');
    expect(summary).toHaveTextContent('f2: the entry is no longer in the setting');
    await waitFor(() => expect(screen.queryByTestId('bulk-undo')).toBeNull());
  });

  it('a 409 not_latest_batch says so', async () => {
    on('GET', `${BASE}/bulk/latest`, [{ id: 'b7', createdAt: null, count: 1 }]);
    on('GET', BASE, [list([])]);
    on('POST', `${BASE}/bulk/b7/undo`, [{ error: 'not_latest_batch' }, 409]);
    renderWithIntl(<PrivacyFieldsView status="suggested" tool={null} />);

    fireEvent.click(await screen.findByTestId('bulk-undo'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Undo' }));
    expect(await within(dialog).findByText(/Only the latest bulk action can be undone/)).toBeInTheDocument();
  });
});
