import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import type { ChannelsListDto, OperatorChannelDto } from '../../../../_lib/channels';
import { ChannelsDashboard } from '../ChannelsDashboard';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

/**
 * Members line for channel rows (Graph-resolved by the channel plugin).
 * The gating logic worth guarding: the line renders only when `members`
 * is non-empty, and the "+N more" suffix appears only when `member_count`
 * exceeds the listed names — equal counts and a missing `member_count`
 * must NOT produce a stray "+0 more".
 */

function channel(over: Partial<OperatorChannelDto>): OperatorChannelDto {
  return {
    channel_type: 'teams',
    channel_key: '19:chat@thread.skype',
    label: 'Project Group',
    origin_plugin_id: '@omadia/channel-teams',
    bound_agent_slug: null,
    stale: false,
    ...over,
  };
}

function dto(channels: OperatorChannelDto[]): ChannelsListDto {
  return {
    channels,
    agents: [{ slug: 'hr', name: 'HR' }],
    fallback_slug: 'hr',
    directory_types: ['teams'],
  };
}

describe('ChannelsDashboard members line', () => {
  it('renders names and the +N suffix when member_count exceeds the list', () => {
    renderWithIntl(
      <ChannelsDashboard
        initial={dto([
          channel({ members: ['Alice Adams', 'Bob Brown'], member_count: 5 }),
        ])}
      />,
    );
    expect(
      screen.getByText(/Members: Alice Adams and Bob Brown/),
    ).toBeDefined();
    expect(screen.getByText(/\+3 more/)).toBeDefined();
  });

  it('omits the +N suffix when member_count equals the listed names', () => {
    renderWithIntl(
      <ChannelsDashboard
        initial={dto([
          channel({ members: ['Alice Adams', 'Bob Brown'], member_count: 2 }),
        ])}
      />,
    );
    expect(screen.getByText(/Members: /)).toBeDefined();
    expect(screen.queryByText(/more/)).toBeNull();
  });

  it('omits the +N suffix when member_count is missing', () => {
    renderWithIntl(
      <ChannelsDashboard
        initial={dto([channel({ members: ['Alice Adams'] })])}
      />,
    );
    expect(screen.getByText(/Members: Alice Adams/)).toBeDefined();
    expect(screen.queryByText(/more/)).toBeNull();
  });

  it('renders no members line when members is absent', () => {
    renderWithIntl(<ChannelsDashboard initial={dto([channel({})])} />);
    expect(screen.queryByText(/Members: /)).toBeNull();
  });
});
