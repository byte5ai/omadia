import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type {
  OperatorAgentDto,
  PluginCatalogEntryDto,
} from '../../../../_lib/agents';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { PluginsDnd } from '../PluginsDnd';

/**
 * Regression — clicking "Config" on an attached plugin blanked the whole
 * orchestrator page with the route error boundary ("Etwas ist schiefgelaufen").
 *
 * Root cause: since #602 (OM-17) the manifest loader normalises every setup
 * field's `label` / `help` into a `{ <locale>: text }` map (`?? { en: key }`),
 * so NO field on a current middleware ships a bare string — 192 of 192 fields
 * in the live catalog were maps. This component still rendered `field.label`
 * straight into JSX, which is React #31 ("Objects are not valid as a React
 * child"). It threw on the first render after the drawer opened, i.e. every
 * plugin with setup fields was unconfigurable from this page.
 *
 * Guarded here: the drawer opens, the map resolves to the active locale, and
 * a pre-#602 bare string still renders as itself.
 *
 * dnd-kit DRAG stays out of jsdom scope (see vitest.config.ts) — this drives
 * the button, not the pointer sensor.
 */

function agent(): OperatorAgentDto {
  return {
    id: 'a1',
    slug: 'marketing',
    name: 'marketing',
    privacyProfile: 'default',
    enabled: true,
    plugins: [{ id: '@omadia/confluence', config: {}, enabled: true }],
    bindings: [],
  } as unknown as OperatorAgentDto;
}

function catalog(
  fields: PluginCatalogEntryDto['setup_fields'],
): PluginCatalogEntryDto[] {
  return [
    {
      id: '@omadia/confluence',
      name: 'Confluence Connector',
      kind: 'integration',
      version: '0.3.3',
      multi_instance: true,
      privacy_class: 'default',
      memory_reads: [],
      memory_writes: [],
      network_outbound: [],
      setup_fields: fields,
      depends_on: [],
    },
  ];
}

function renderDnd(
  fields: PluginCatalogEntryDto['setup_fields'],
  locale: 'de' | 'en' = 'en',
): void {
  renderWithIntl(
    <PluginsDnd
      agent={agent()}
      catalog={catalog(fields)}
      isFallback={false}
      disabled={false}
      onReplace={vi.fn()}
    />,
    { locale },
  );
}

describe('PluginsDnd config drawer — localized setup fields', () => {
  it('opens the drawer and renders a localized label map instead of crashing', async () => {
    const user = userEvent.setup();
    renderDnd([
      {
        key: 'confluence_base_url',
        label: { en: 'Confluence Base URL', de: 'Confluence Basis-URL' },
        type: 'string',
        help: { en: 'No trailing slash needed.' },
      },
    ]);

    await user.click(screen.getByRole('button', { name: 'Config' }));

    expect(screen.getByText(/Confluence Base URL/)).toBeInTheDocument();
    expect(screen.getByText(/No trailing slash needed\./)).toBeInTheDocument();
  });

  it('prefers the active locale', async () => {
    const user = userEvent.setup();
    renderDnd(
      [
        {
          key: 'confluence_base_url',
          label: { en: 'Confluence Base URL', de: 'Confluence Basis-URL' },
          type: 'string',
        },
      ],
      'de',
    );

    await user.click(screen.getByRole('button', { name: 'Config' }));

    expect(screen.getByText(/Confluence Basis-URL/)).toBeInTheDocument();
  });

  it('still renders a bare string from a pre-#602 middleware', async () => {
    const user = userEvent.setup();
    renderDnd([
      { key: 'legacy_key', label: 'Legacy Label', type: 'string' },
    ]);

    await user.click(screen.getByRole('button', { name: 'Config' }));

    expect(screen.getByText(/Legacy Label/)).toBeInTheDocument();
  });

  it('falls back to the field key when the map is empty', async () => {
    const user = userEvent.setup();
    renderDnd([{ key: 'orphan_key', label: {}, type: 'string' }]);

    await user.click(screen.getByRole('button', { name: 'Config' }));

    expect(screen.getByText(/orphan_key/)).toBeInTheDocument();
  });
});
