import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type {
  OperatorAgentDto,
  PluginCatalogEntryDto,
} from '../../../../_lib/agents';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { PluginsDnd } from '../PluginsDnd';

/**
 * The per-(orchestrator × plugin) config editor, after it moved out of the
 * inline drawer into a dialog (store-editor row schema: key · type · storage
 * class · label · help · control · provenance).
 *
 * What is guarded here is the part an operator can get wrong silently: whether
 * a field is this orchestrator's own override or a value inherited from the
 * store-level install config. An empty text box means both things unless the
 * row says which — so the count, the per-row status line and the reset path
 * all have tests.
 */

const FIELDS: PluginCatalogEntryDto['setup_fields'] = [
  {
    key: 'odoo_url',
    label: { en: 'Odoo URL', de: 'Odoo URL' },
    type: 'string',
    help: { en: 'Base URL of the Odoo instance.' },
  },
  {
    key: 'odoo_api_key',
    label: { en: 'API key' },
    type: 'secret',
  },
  {
    key: 'odoo_page_size',
    label: { en: 'Page size' },
    type: 'string',
    default: '100',
  },
];

function agent(config: Record<string, unknown>): OperatorAgentDto {
  return {
    id: 'a1',
    slug: 'hr',
    name: 'human-ressources',
    privacyProfile: 'default',
    enabled: true,
    plugins: [{ id: '@omadia/integration-odoo', config, enabled: true }],
    bindings: [],
  } as unknown as OperatorAgentDto;
}

function catalog(): PluginCatalogEntryDto[] {
  return [
    {
      id: '@omadia/integration-odoo',
      name: 'Odoo Connector',
      kind: 'integration',
      version: '0.2.0',
      multi_instance: true,
      privacy_class: 'default',
      memory_reads: [],
      memory_writes: [],
      network_outbound: [],
      setup_fields: FIELDS,
      depends_on: [],
    },
  ];
}

function renderDnd(config: Record<string, unknown> = {}): {
  onReplace: ReturnType<typeof vi.fn>;
} {
  const onReplace = vi.fn();
  renderWithIntl(
    <PluginsDnd
      agent={agent(config)}
      catalog={catalog()}
      isFallback={false}
      disabled={false}
      onReplace={onReplace}
    />,
    { locale: 'en' },
  );
  return { onReplace };
}

async function openConfig(): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /^Config/ }));
  return screen.getByRole('dialog');
}

describe('PluginConfigModal', () => {
  it('opens as a dialog titled after the plugin', async () => {
    renderDnd();
    const dialog = await openConfig();

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(
      within(dialog).getByText('Configuration — Odoo Connector'),
    ).toBeInTheDocument();
  });

  it('renders every declared field with its key and storage class', async () => {
    renderDnd();
    const dialog = await openConfig();

    expect(within(dialog).getByText('odoo_url')).toBeInTheDocument();
    expect(within(dialog).getByText('odoo_api_key')).toBeInTheDocument();
    // The secret gets the vault badge and the "this is not your password"
    // warning; the plain string gets the config badge.
    expect(within(dialog).getByText('Secret · Vault')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Config')).not.toHaveLength(0);
  });

  it('counts nothing as overridden when the config map is empty', async () => {
    renderDnd();
    const dialog = await openConfig();

    expect(within(dialog).getByText('0 of 3 overridden')).toBeInTheDocument();
    expect(
      within(dialog).getAllByText(/from the store configuration/),
    ).toHaveLength(3);
  });

  it('marks a present key as overriding the store configuration', async () => {
    renderDnd({ odoo_url: 'https://erp.example.com' });
    const dialog = await openConfig();

    expect(within(dialog).getByText('1 of 3 overridden')).toBeInTheDocument();
    expect(
      within(dialog).getByText('overrides the store configuration'),
    ).toBeInTheDocument();
  });

  it('treats an explicit empty string as an override, not as unset', async () => {
    renderDnd({ odoo_url: '' });
    const dialog = await openConfig();

    expect(within(dialog).getByText('1 of 3 overridden')).toBeInTheDocument();
  });

  it('shows the manifest default as the placeholder of an inherited field', async () => {
    renderDnd();
    const dialog = await openConfig();

    expect(
      within(dialog).getByPlaceholderText('100'),
    ).toBeInTheDocument();
  });

  it('drops the key from the payload when a single override is reset', async () => {
    const user = userEvent.setup();
    const { onReplace } = renderDnd({
      odoo_url: 'https://erp.example.com',
      odoo_page_size: '250',
    });
    const dialog = await openConfig();

    const resets = within(dialog).getAllByRole('button', {
      name: 'Reset to the store value',
    });
    expect(resets).toHaveLength(2);
    await user.click(resets[0]!);

    expect(within(dialog).getByText('1 of 3 overridden')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onReplace).toHaveBeenCalledWith([
      {
        id: '@omadia/integration-odoo',
        enabled: true,
        config: { odoo_page_size: '250' },
      },
    ]);
  });

  it('clears every override at once', async () => {
    const user = userEvent.setup();
    const { onReplace } = renderDnd({
      odoo_url: 'https://erp.example.com',
      odoo_page_size: '250',
    });
    const dialog = await openConfig();

    await user.click(
      within(dialog).getByRole('button', { name: /Clear all overrides/ }),
    );

    expect(within(dialog).getByText('0 of 3 overridden')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onReplace).toHaveBeenCalledWith([
      { id: '@omadia/integration-odoo', enabled: true, config: {} },
    ]);
  });

  it('typing a value turns an inherited field into an override', async () => {
    const user = userEvent.setup();
    renderDnd();
    const dialog = await openConfig();

    await user.type(
      within(dialog).getByPlaceholderText('100'),
      '250',
    );

    expect(within(dialog).getByText('1 of 3 overridden')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderDnd();
    await openConfig();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('badges the trigger with the override count', async () => {
    renderDnd({ odoo_url: 'https://erp.example.com' });

    expect(
      screen.getByRole('button', { name: /^Config/ }),
    ).toHaveTextContent(/^Config\s*1$/);
  });
});
