import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import type { ChannelsListDto, OperatorChannelDto } from '../../../../_lib/channels';
import { ChannelsDashboard } from '../ChannelsDashboard';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

/**
 * #1880 / #2055 — a binding to a disabled or deleted agent is still that
 * agent's binding: the row names it with a marker instead of showing the
 * first `<select>` option (the default agent), and the unbound option names
 * the instance default agent, or "off".
 */

function channel(over: Partial<OperatorChannelDto>): OperatorChannelDto {
  return {
    channel_type: 'teams',
    channel_key: '19:chat@thread.skype',
    label: 'Project Group',
    origin_plugin_id: '@omadia/channel-teams',
    bound_agent_slug: null,
    bound_agent_status: null,
    bound_agent_name: null,
    stale: false,
    ...over,
  };
}

function dto(row: OperatorChannelDto, defaultSlug: string | null): ChannelsListDto {
  return {
    channels: [row],
    agents: [{ slug: 'hr', name: 'HR' }],
    instance_default_slug: defaultSlug,
    directory_types: ['teams'],
  };
}

function selected(): HTMLOptionElement | undefined {
  const select = screen.getByRole('combobox') as HTMLSelectElement;
  return select.selectedOptions[0];
}

describe('ChannelsDashboard — bound agent state', () => {
  it('names a disabled bound agent with a marker', () => {
    renderWithIntl(
      <ChannelsDashboard
        initial={dto(
          channel({ bound_agent_slug: 'sales', bound_agent_status: 'disabled', bound_agent_name: 'Sales' }),
          'hr',
        )}
      />,
    );
    expect(selected()?.textContent).toBe('Sales (disabled)');
  });

  it('names a deleted bound agent with a marker', () => {
    renderWithIntl(
      <ChannelsDashboard
        initial={dto(
          channel({ bound_agent_slug: null, bound_agent_status: 'deleted', bound_agent_name: 'Mira' }),
          'hr',
        )}
      />,
    );
    expect(selected()?.textContent).toBe('Mira (deleted)');
  });

  it('selects the bound agent when it is enabled', () => {
    renderWithIntl(
      <ChannelsDashboard
        initial={dto(
          channel({ bound_agent_slug: 'hr', bound_agent_status: 'enabled', bound_agent_name: 'HR' }),
          'hr',
        )}
      />,
    );
    expect(selected()?.value).toBe('hr');
  });

  it('says "off" when no instance default agent is set', () => {
    renderWithIntl(<ChannelsDashboard initial={dto(channel({}), null)} />);
    expect(selected()?.textContent).toBe('(default agent · off)');
  });
});
