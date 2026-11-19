import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../../_lib/api';
import type { ChannelsListDto } from '../../../../_lib/channels';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { ChannelsDashboard } from '../ChannelsDashboard';

/**
 * #2066 — a channel is never bound to a facilitator.
 *
 * The kernel refuses it (409 `facilitator_omission` / `channel_binding`), so
 * the dropdown does not offer a facilitator, whether the page names it by
 * slug or the route reports its `kind`. If the refusal still arrives (a stale
 * page, an agent list that could not be read), it is a sentence.
 */

const { mockSet } = vi.hoisted(() => ({ mockSet: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock('../../../../_lib/channels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/channels')>()),
  setChannelBinding: mockSet,
}));

function dto(agents: ChannelsListDto['agents']): ChannelsListDto {
  return {
    channels: [
      {
        channel_type: 'teams',
        channel_key: '19:chat@thread.skype',
        label: 'Project Group',
        origin_plugin_id: '@omadia/channel-teams',
        bound_agent_slug: null,
        stale: false,
      },
    ],
    agents,
    fallback_slug: 'hr',
    directory_types: ['teams'],
  };
}

function options(): string[] {
  return [...(screen.getByRole('combobox') as HTMLSelectElement).options].map((o) => o.value);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('ChannelsDashboard — facilitators (#2066)', () => {
  it('does not offer a facilitator named by the page', () => {
    renderWithIntl(
      <ChannelsDashboard
        initial={dto([
          { slug: 'hr', name: 'HR' },
          { slug: 'mona', name: 'Mona' },
        ])}
        facilitatorSlugs={['mona']}
      />,
    );
    expect(options()).toEqual(['', 'hr']);
  });

  it('does not offer a facilitator the route reports by kind', () => {
    renderWithIntl(
      <ChannelsDashboard
        initial={dto([
          { slug: 'hr', name: 'HR', kind: 'standard' },
          { slug: 'mona', name: 'Mona', kind: 'facilitator' },
        ])}
      />,
    );
    expect(options()).toEqual(['', 'hr']);
  });

  it('shows the refusal as a sentence when it still happens', async () => {
    mockSet.mockRejectedValue(
      new ApiError(
        409,
        'PUT failed: 409',
        JSON.stringify({
          error: 'facilitator_omission',
          omission: 'channel_binding',
          message: 'agent "mona" is a facilitator: server prose',
        }),
      ),
    );
    // The page could not tell which agents are facilitators.
    renderWithIntl(
      <ChannelsDashboard
        initial={dto([
          { slug: 'hr', name: 'HR' },
          { slug: 'mona', name: 'Mona' },
        ])}
      />,
    );
    await userEvent.selectOptions(screen.getByRole('combobox'), 'mona');
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        'A facilitator cannot be bound to a channel',
      ),
    );
    expect(document.body.textContent).not.toContain('server prose');
  });
});
