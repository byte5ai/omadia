import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FieldClassificationItem, FieldClassificationList } from '../../../_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import { PrivacyFieldsView } from '../_components/PrivacyFieldsView';

/**
 * #1556 follow-up — /admin/privacy-fields. Rows come from
 * GET …/field-classification?status=, reasons render localized from their
 * codes, decisions POST the item's fingerprint, and a 409 is handled
 * (stale → reload + message, covered_by_legacy → message naming the entry).
 */

const fetchMock = vi.fn();

const DATASET = '0f5c1c3a-1111-4222-8333-444455556666';
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
    reasons: [
      { code: 'known_non_personal', models: ['hr.department'] },
      { code: 'sample_clean', sampleCount: 42 },
    ],
    configEntry: 'odoo_execute:hr.employee/department_id',
    fingerprint: 'fp-1',
    decision: null,
    firstSeenAt: '2026-10-29T08:00:00.000Z',
    lastSeenAt: '2026-10-30T08:00:00.000Z',
    seenCount: 12,
    ...over,
  };
}

function list(items: FieldClassificationItem[], over: Partial<FieldClassificationList> = {}): FieldClassificationList {
  return {
    items,
    counts: {
      suggested: 1,
      needs_clarification: 2,
      personal: 3,
      confirmed: 4,
      confirmed_conflict: 1,
      rejected: 0,
      kept_masked: 0,
    },
    newSinceLastVisit: 0,
    computedAt: '2026-10-30T09:15:00.000Z',
    ...over,
  };
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function call(n: number): { url: URL; init: RequestInit | undefined } {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit | undefined];
  return { url: new URL(url, 'http://localhost'), init };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('<PrivacyFieldsView />', () => {
  it('requests the status/tool filter and renders grouped fields with localized reasons', async () => {
    fetchMock.mockResolvedValueOnce(
      respond(
        list([
          item(),
          item({ id: 'f2', toolName: 'odoo_search_read', fieldPath: 'country_id', fingerprint: 'fp-2' }),
          item({
            id: 'f3',
            toolName: 'odoo_search_read',
            fieldPath: 'stage_id',
            reasons: [{ code: 'some_future_code' }],
          }),
        ]),
      ),
    );
    renderWithIntl(<PrivacyFieldsView status="suggested" tool="odoo_execute" />);

    expect(await screen.findByText('department_id')).toBeInTheDocument();
    const { url } = call(0);
    expect(url.pathname).toBe(BASE);
    expect(url.searchParams.get('status')).toBe('suggested');
    expect(url.searchParams.get('tool')).toBe('odoo_execute');

    expect(screen.getByTestId('tool-odoo_execute')).toBeInTheDocument();
    expect(screen.getByTestId('tool-odoo_search_read')).toBeInTheDocument();
    expect(
      screen.getAllByText('Points to a known non-personal model: hr.department.'),
    ).toHaveLength(2);
    expect(screen.getAllByText('42 sampled values showed no personal data.')).toHaveLength(2);
    expect(screen.getByText('Other reason (some_future_code).')).toBeInTheDocument();
    // Tabs carry the server counts and keep the tool filter.
    const tab = screen.getByTestId('tab-needs_clarification');
    expect(tab).toHaveTextContent('Needs clarification2');
    expect(tab.getAttribute('href')).toBe(
      '/admin/privacy-fields?status=needs_clarification&tool=odoo_execute',
    );
    expect(screen.getByTestId('tab-suggested').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('last-computed')).toHaveTextContent('Last computed:');
    expect(screen.getByText(/nothing is cleared until an admin confirms/i)).toBeInTheDocument();
  });

  it('renders German reasons, the decision line and only revert for a confirmed field', async () => {
    fetchMock.mockResolvedValueOnce(
      respond(
        list([
          item({
            status: 'confirmed',
            reasons: [
              { code: 'haiku_non_personal', model: 'x_custom.region', confidence: 0.92 },
              { code: 'identity_hit', hitTypes: ['email'] },
            ],
            decision: { action: 'confirm', by: 'admin@example.com', at: '2026-10-30T10:00:00.000Z' },
          }),
        ]),
      ),
    );
    renderWithIntl(<PrivacyFieldsView status="confirmed" tool={null} />, { locale: 'de' });

    expect(await screen.findByText(/x_custom\.region als nicht personenbezogen ein \(Konfidenz 92/)).toBeInTheDocument();
    expect(screen.getByText('Stichprobenwerte passten auf Identitätsmuster: email.')).toBeInTheDocument();
    expect(screen.getByTestId('field-decision')).toHaveTextContent('Bestätigt von admin@example.com am');
    const card = screen.getByTestId('field-f1');
    expect(within(card).getByRole('button', { name: 'Zurücknehmen' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Bestätigen' })).toBeNull();
  });

  it('renders the empty state and a missing computedAt', async () => {
    fetchMock.mockResolvedValueOnce(respond(list([], { computedAt: null })));
    renderWithIntl(<PrivacyFieldsView status="rejected" tool={null} />);
    expect(await screen.findByText('No fields with this status.')).toBeInTheDocument();
    expect(screen.getByTestId('last-computed')).toHaveTextContent('Not computed yet.');
  });

  it('confirm posts the action with the fingerprint and reloads', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(list([item()])))
      .mockResolvedValueOnce(respond({ item: item({ status: 'confirmed' }) }))
      .mockResolvedValueOnce(respond(list([])));
    renderWithIntl(<PrivacyFieldsView status="suggested" tool={null} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const { url, init } = call(1);
    expect(url.pathname).toBe(`${BASE}/f1/decision`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'confirm', fingerprint: 'fp-1' });
    expect(call(2).url.pathname).toBe(BASE);
    expect(await screen.findByText('Saved: odoo_execute:hr.employee/department_id')).toBeInTheDocument();
  });

  it('reject and keep masked send their own action', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(list([item({ status: 'needs_clarification' })])))
      .mockResolvedValueOnce(respond({ item: item({ status: 'rejected' }) }))
      .mockResolvedValueOnce(respond(list([item({ status: 'needs_clarification' })])));
    renderWithIntl(<PrivacyFieldsView status="needs_clarification" tool={null} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Keep masked' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String(call(1).init?.body))).toEqual({
      action: 'keep_masked',
      fingerprint: 'fp-1',
    });
  });

  it('a 409 stale_fingerprint reloads the list and says so', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(list([item()])))
      .mockResolvedValueOnce(respond({ error: 'stale_fingerprint' }, 409))
      .mockResolvedValueOnce(respond(list([item({ fingerprint: 'fp-new' })])));
    renderWithIntl(<PrivacyFieldsView status="suggested" tool={null} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));

    expect(
      await screen.findByText(/This field changed since the list was loaded/),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(call(2).url.pathname).toBe(BASE);
  });

  it('a 409 covered_by_legacy names the entry and does not reload', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(list([item({ status: 'confirmed' })])))
      .mockResolvedValueOnce(respond({ error: 'covered_by_legacy', entry: '*:department_id' }, 409));
    renderWithIntl(<PrivacyFieldsView status="confirmed" tool={null} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Revert' }));

    expect(
      await screen.findByText(/cleared by the legacy entry \*:department_id, which applies to all models/),
    ).toBeInTheDocument();
    expect(JSON.parse(String(call(1).init?.body))).toEqual({ action: 'revert', fingerprint: 'fp-1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('show sample shows the real values with the admin/audit note', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(list([item()])))
      .mockResolvedValueOnce(
        respond({ samples: ['Research & Development', 'Sales'], maskedSamples: ['R••••••• & D••••••••••'] }),
      );
    renderWithIntl(<PrivacyFieldsView status="suggested" tool={null} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Show sample' }));

    expect(await screen.findByText('Research & Development')).toBeInTheDocument();
    expect(screen.getByText('Sales')).toBeInTheDocument();
    expect(screen.getByTestId('field-sample-note')).toHaveTextContent(
      'Visible to admins only. Opening this view is audited.',
    );
    expect(screen.queryByText('R••••••• & D••••••••••')).toBeNull();
    expect(call(1).url.pathname).toBe(`${BASE}/f1/preview`);
  });

  it('show sample falls back to the masked sample when no real value is buffered', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(list([item()])))
      .mockResolvedValueOnce(respond({ samples: [], maskedSamples: ['R••••••• & D••••••••••'] }));
    renderWithIntl(<PrivacyFieldsView status="suggested" tool={null} />, { locale: 'de' });

    fireEvent.click(await screen.findByRole('button', { name: 'Stichprobe zeigen' }));

    expect(await screen.findByText('R••••••• & D••••••••••')).toBeInTheDocument();
    expect(screen.getByTestId('field-sample-masked')).toBeInTheDocument();
    expect(screen.getByTestId('field-sample-note')).toHaveTextContent('Nur für Admins sichtbar.');
  });

  it('shows source and scope (model / dataset / no model), the entry and a legacy note', async () => {
    fetchMock.mockResolvedValueOnce(
      respond(
        list([
          item(),
          item({
            id: 'f2',
            toolName: 'query_dataset',
            scope: DATASET,
            fieldPath: 'Abteilung',
            label: 'Abteilung',
            configEntry: `dataset:${DATASET}/Abteilung`,
          }),
          item({
            id: 'f3',
            toolName: 'mcp_shop',
            scope: '-',
            fieldPath: 'category',
            label: 'Product category',
            configEntry: 'mcp_shop:-/category',
            status: 'confirmed',
            reasons: [{ code: 'legacy_entry', entry: '*:category' }],
          }),
        ]),
      ),
    );
    renderWithIntl(<PrivacyFieldsView status="suggested" tool={null} />);

    const emp = await screen.findByTestId('field-f1');
    expect(within(emp).getByTestId('field-source')).toHaveTextContent('odoo_execute · Model hr.employee');
    expect(within(emp).getByText('odoo_execute:hr.employee/department_id')).toBeInTheDocument();
    const dataset = screen.getByTestId('field-f2');
    expect(within(dataset).getByTestId('field-source')).toHaveTextContent(`query_dataset · Dataset ${DATASET}`);
    expect(within(dataset).getByText(`dataset:${DATASET}/Abteilung`)).toBeInTheDocument();
    const mcp = screen.getByTestId('field-f3');
    expect(within(mcp).getByTestId('field-source')).toHaveTextContent('mcp_shop · Every call of this tool');
    expect(within(mcp).getByText('Product category')).toBeInTheDocument();
    expect(
      within(mcp).getByText('Cleared by the legacy entry *:category — it applies to all models.'),
    ).toBeInTheDocument();
    const link = within(mcp).getByRole('link', { name: 'Review legacy entries' });
    expect(link.getAttribute('href')).toBe('/admin/privacy-fields?view=legacy');
    expect(screen.getByTestId('tab-legacy').getAttribute('href')).toBe('/admin/privacy-fields?view=legacy');
  });

  it('a dataset preview shows masked samples only, with the owner note (en + de)', async () => {
    for (const [locale, button, note] of [
      ['en', 'Show sample', 'Uploaded datasets show masked samples only — the rows belong to the uploading user.'],
      ['de', 'Stichprobe zeigen', 'Hochgeladene Datensätze zeigen nur maskierte Stichproben'],
    ] as const) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(
          respond(list([item({ toolName: 'query_dataset', scope: DATASET, fieldPath: 'Abteilung' })])),
        )
        .mockResolvedValueOnce(
          respond({ samples: [], maskedSamples: ['R••••••• & D••••••••••'], samplesWithheld: 'owner_scoped_dataset' }),
        );
      const view = renderWithIntl(<PrivacyFieldsView status="suggested" tool={null} />, { locale });
      fireEvent.click(await screen.findByRole('button', { name: button }));
      expect(await screen.findByTestId('field-sample-masked')).toBeInTheDocument();
      expect(screen.queryByTestId('field-sample-real')).toBeNull();
      expect(screen.getByTestId('field-sample-note')).toHaveTextContent(note);
      view.unmount();
    }
  });

  it('renders no_scope and the "every call of this tool" scope (en + de)', async () => {
    const noScope = item({
      toolName: 'mcp_shop',
      scope: '-',
      fieldPath: 'category',
      configEntry: 'mcp_shop:-/category',
      status: 'needs_clarification',
      reasons: [{ code: 'no_scope' }],
    });
    fetchMock.mockResolvedValueOnce(respond(list([noScope])));
    const en = renderWithIntl(<PrivacyFieldsView status="needs_clarification" tool={null} />);
    expect(await screen.findByText(/an entry would apply to every call of this tool/)).toBeInTheDocument();
    expect(screen.getByTestId('field-source')).toHaveTextContent('mcp_shop · Every call of this tool');
    en.unmount();

    fetchMock.mockResolvedValueOnce(respond(list([noScope])));
    renderWithIntl(<PrivacyFieldsView status="needs_clarification" tool={null} />, { locale: 'de' });
    expect(await screen.findByText(/ein Eintrag gälte also für jeden Aufruf dieses Tools/)).toBeInTheDocument();
    expect(screen.getByTestId('field-source')).toHaveTextContent('mcp_shop · Jeder Aufruf dieses Tools');
  });

  it('renders name_detector_unavailable in German', async () => {
    fetchMock.mockResolvedValueOnce(
      respond(list([item({ status: 'needs_clarification', reasons: [{ code: 'name_detector_unavailable' }] })])),
    );
    renderWithIntl(<PrivacyFieldsView status="needs_clarification" tool={null} />, { locale: 'de' });
    expect(await screen.findByText(/Die Namenserkennung war nicht verfügbar/)).toBeInTheDocument();
  });

  it('renders a field seeded from the Odoo schema as not seen yet, in German', async () => {
    fetchMock.mockResolvedValueOnce(
      respond(
        list([item({ status: 'needs_clarification', seenCount: 0, reasons: [{ code: 'not_seen_yet' }] })]),
      ),
    );
    renderWithIntl(<PrivacyFieldsView status="needs_clarification" tool={null} />, { locale: 'de' });
    expect(await screen.findByText(/Nur aus dem Odoo-Schema bekannt/)).toBeInTheDocument();
    expect(screen.getByText(/noch in keinem Chat gesehen/)).toBeInTheDocument();
  });

  it('recompute posts and reloads', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(list([])))
      .mockResolvedValueOnce(respond({ computedAt: '2026-10-30T11:00:00.000Z' }, 202))
      .mockResolvedValueOnce(respond(list([])));
    renderWithIntl(<PrivacyFieldsView status="suggested" tool={null} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Recompute' }));

    expect(await screen.findByText('Recomputed. The list is up to date.')).toBeInTheDocument();
    const { url, init } = call(1);
    expect(url.pathname).toBe(`${BASE}/recompute`);
    expect(init?.method).toBe('POST');
  });

  it('a confirmed field in conflict explains why and offers confirm again + revert', async () => {
    const conflict = item({
      fieldPath: 'partner_id',
      relationModels: ['res.partner'],
      status: 'confirmed_conflict',
      reasons: [{ code: 'confirmed_conflict' }, { code: 'person_model', models: ['res.partner'] }],
      configEntry: 'odoo_execute:partner_id',
    });
    fetchMock
      .mockResolvedValueOnce(respond(list([conflict])))
      .mockResolvedValueOnce(respond({ item: { ...conflict, status: 'confirmed' } }))
      .mockResolvedValueOnce(respond(list([])));
    renderWithIntl(<PrivacyFieldsView status="confirmed_conflict" tool={null} />);

    expect(
      await screen.findByText(
        'This field is in the list, but it now points to a person model or changed since it was confirmed — review it or remove it.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('tab-confirmed_conflict')).toHaveTextContent('Confirmed — needs review');
    expect(screen.getByTestId('tab-confirmed_conflict').getAttribute('aria-current')).toBe('page');
    const card = screen.getByTestId('field-f1');
    expect(within(card).getByText('Confirmed — needs review')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Revert' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Keep masked' })).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: 'Confirm again' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String(call(1).init?.body))).toEqual({ action: 'confirm', fingerprint: 'fp-1' });
  });

  it('renders the conflict status and reason in German', async () => {
    fetchMock.mockResolvedValueOnce(
      respond(list([item({ status: 'confirmed_conflict', reasons: [{ code: 'confirmed_conflict' }] })])),
    );
    renderWithIntl(<PrivacyFieldsView status="confirmed_conflict" tool={null} />, { locale: 'de' });
    expect(
      await screen.findByText(/verweist aber jetzt auf ein Personenmodell/),
    ).toBeInTheDocument();
    expect(screen.getByTestId('tab-confirmed_conflict')).toHaveTextContent('Bestätigt — prüfen');
    expect(screen.getByRole('button', { name: 'Erneut bestätigen' })).toBeInTheDocument();
  });

  it('a 409 invalid_field says the field cannot be listed and does not reload', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(list([item()])))
      .mockResolvedValueOnce(respond({ error: 'invalid_field' }, 409));
    renderWithIntl(<PrivacyFieldsView status="suggested" tool={null} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    expect(
      await screen.findByText(/cannot be added to non_personal_fields as a single entry/),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a failed load shows a localized error', async () => {
    fetchMock.mockResolvedValueOnce(respond({ code: 'boom', message: 'db down' }, 500));
    renderWithIntl(<PrivacyFieldsView status="suggested" tool={null} />);
    expect(await screen.findByText('The field list could not be loaded.')).toBeInTheDocument();
    expect(screen.getByText('Technical detail: db down')).toBeInTheDocument();
  });
});

describe('undoing a decision', () => {
  it('offers revert on rejected and kept-masked fields', async () => {
    const { actionsFor } = await import('../_components/FieldCard');
    expect(actionsFor('rejected')).toEqual(['revert']);
    expect(actionsFor('kept_masked')).toEqual(['revert']);
  });

  it('offers acknowledge (confirm) and revert on a confirmed field in conflict', async () => {
    const { actionsFor, actionLabelKey } = await import('../_components/FieldCard');
    expect(actionsFor('confirmed_conflict')).toEqual(['confirm', 'revert']);
    expect(actionLabelKey('confirmed_conflict', 'confirm')).toBe('actions.acknowledge');
    expect(actionLabelKey('suggested', 'confirm')).toBe('actions.confirm');
  });
});
