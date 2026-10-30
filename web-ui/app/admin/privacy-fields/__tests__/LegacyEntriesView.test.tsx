import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { LegacyEntriesView } from '../_components/LegacyEntriesView';

/**
 * Contract v2 — `/admin/privacy-fields?view=legacy`: legacy entries apply to
 * every model; each lists the fields it covers and converts to model-scoped
 * entries via POST …/legacy/convert.
 */

const fetchMock = vi.fn();
const BASE = '/bot-api/v1/admin/privacy/field-classification';
const DATASET = '0f5c1c3a-1111-4222-8333-444455556666';

const ENTRIES = {
  entries: [
    {
      entry: 'odoo_execute:department_id',
      covers: [
        {
          id: 'f1',
          toolName: 'odoo_execute',
          scope: 'hr.employee',
          fieldPath: 'department_id',
          configEntry: 'odoo_execute:hr.employee/department_id',
          personal: false,
        },
        {
          id: 'f2',
          toolName: 'query_dataset',
          scope: DATASET,
          fieldPath: 'department_id',
          configEntry: `dataset:${DATASET}/department_id`,
          personal: false,
        },
        {
          id: 'f3',
          toolName: 'odoo_execute',
          scope: 'crm.lead',
          fieldPath: 'department_id',
          configEntry: 'odoo_execute:crm.lead/department_id',
          personal: true,
        },
      ],
    },
    { entry: '*:job_id', covers: [] },
  ],
};

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

describe('<LegacyEntriesView />', () => {
  it('lists legacy entries with the "applies to all models" note and their covered fields', async () => {
    fetchMock.mockResolvedValueOnce(respond(ENTRIES));
    renderWithIntl(<LegacyEntriesView />);

    const card = await screen.findByTestId('legacy-odoo_execute:department_id');
    expect(call(0).url.pathname).toBe(`${BASE}/legacy`);
    expect(within(card).getByText('Legacy — applies to all models')).toBeInTheDocument();
    expect(within(card).getByText('Covers 3 seen fields')).toBeInTheDocument();
    expect(within(card).getByTestId('legacy-cover-f3')).toHaveTextContent(
      'looks personal — not converted, masked afterwards',
    );
    expect(within(card).getByTestId('legacy-cover-f3')).not.toHaveTextContent('odoo_execute:crm.lead/department_id');
    expect(within(card).getByText(/odoo_execute · Model hr\.employee · department_id/)).toBeInTheDocument();
    expect(within(card).getByText(new RegExp(`query_dataset · Dataset ${DATASET}`))).toBeInTheDocument();
    const empty = screen.getByTestId('legacy-*:job_id');
    expect(within(empty).getByText(/Covers no field seen so far/)).toBeInTheDocument();
  });

  it('converts an entry, reports the result and reloads', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(ENTRIES))
      .mockResolvedValueOnce(
        respond({
          entry: 'odoo_execute:department_id',
          added: ['odoo_execute:hr.employee/department_id', `dataset:${DATASET}/department_id`],
          skipped: [],
          skippedPersonal: [ENTRIES.entries[0]!.covers[2]],
          conflicts: ['f9'],
        }),
      )
      .mockResolvedValueOnce(respond({ entries: [ENTRIES.entries[1]] }));
    renderWithIntl(<LegacyEntriesView />);

    const card = await screen.findByTestId('legacy-odoo_execute:department_id');
    fireEvent.click(within(card).getByRole('button', { name: 'Convert to model-scoped entries' }));

    expect(
      await screen.findByText('odoo_execute:department_id converted: 2 scoped entries added.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 field still needs review/)).toBeInTheDocument();
    const skipped = screen.getByTestId('legacy-skipped-personal');
    expect(skipped).toHaveTextContent('1 field looks personal and was not converted. It is masked now');
    expect(skipped).toHaveTextContent('odoo_execute · Model crm.lead · department_id');
    const { url, init } = call(1);
    expect(url.pathname).toBe(`${BASE}/legacy/convert`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ entry: 'odoo_execute:department_id' });
    expect(call(2).url.pathname).toBe(`${BASE}/legacy`);
    expect(screen.queryByTestId('legacy-odoo_execute:department_id')).toBeNull();
  });

  it('a 409 legacy_entry_not_found says so (German) and reloads', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(ENTRIES))
      .mockResolvedValueOnce(respond({ error: 'legacy_entry_not_found', entry: '*:job_id' }, 409))
      .mockResolvedValueOnce(respond({ entries: [] }));
    renderWithIntl(<LegacyEntriesView />, { locale: 'de' });

    const card = await screen.findByTestId('legacy-*:job_id');
    fireEvent.click(within(card).getByRole('button', { name: 'In modellbezogene Einträge umwandeln' }));

    expect(await screen.findByText(/Der Eintrag \*:job_id steht nicht mehr in der Einstellung/)).toBeInTheDocument();
    expect(await screen.findByTestId('legacy-empty')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('another failure shows a localized error and keeps the list', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(ENTRIES))
      .mockResolvedValueOnce(respond({ error: 'field_classification_convert_failed' }, 500));
    renderWithIntl(<LegacyEntriesView />);

    const card = await screen.findByTestId('legacy-*:job_id');
    fireEvent.click(within(card).getByRole('button', { name: 'Convert to model-scoped entries' }));

    expect(await screen.findByText('The entry *:job_id could not be converted.')).toBeInTheDocument();
    expect(screen.getByTestId('legacy-odoo_execute:department_id')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('names skipped personal fields in German', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(ENTRIES))
      .mockResolvedValueOnce(
        respond({
          entry: 'odoo_execute:department_id',
          added: [],
          skipped: [],
          skippedPersonal: [ENTRIES.entries[0]!.covers[2]],
          conflicts: [],
        }),
      )
      .mockResolvedValueOnce(respond({ entries: [] }));
    renderWithIntl(<LegacyEntriesView />, { locale: 'de' });
    const card = await screen.findByTestId('legacy-odoo_execute:department_id');
    expect(within(card).getByTestId('legacy-cover-f3')).toHaveTextContent('wirkt personenbezogen');
    fireEvent.click(within(card).getByRole('button', { name: 'In modellbezogene Einträge umwandeln' }));
    expect(await screen.findByTestId('legacy-skipped-personal')).toHaveTextContent(
      '1 Feld wirkt personenbezogen und wurde nicht umgewandelt. Es ist jetzt maskiert',
    );
  });

  it('a failed load shows a localized error', async () => {
    fetchMock.mockResolvedValueOnce(respond({ error: 'boom' }, 500));
    renderWithIntl(<LegacyEntriesView />);
    expect(await screen.findByText('The legacy entries could not be loaded.')).toBeInTheDocument();
  });
});
