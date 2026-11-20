import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAgentDirectory = vi.fn();
vi.mock('./agents', () => ({ getAgentDirectory: (c: string) => getAgentDirectory(c) }));

import { fetchAvailableAgents } from './availableAgents';

describe('fetchAvailableAgents (#2057, directory endpoint)', () => {
  beforeEach(() => getAgentDirectory.mockReset());

  it('asks for the web channel by default and maps the directory', async () => {
    getAgentDirectory.mockResolvedValue({
      channel: 'web',
      agents: [
        {
          slug: 'mira',
          display_name: 'Mira',
          short_description: 'Sales',
          avatar_url: '/api/v1/agents/mira/avatar',
          archetype: 'standard',
        },
        { slug: 'tom', display_name: ' ', short_description: null, avatar_url: null, archetype: 'facilitator' },
      ],
      default_agent: { slug: 'mira' },
    });
    const result = await fetchAvailableAgents();
    expect(getAgentDirectory).toHaveBeenCalledWith('web');
    expect(result.defaultSlug).toBe('mira');
    expect(result.defaultNotice).toBeNull();
    expect(result.agents[0]).toMatchObject({
      slug: 'mira',
      name: 'Mira',
      avatarUrl: '/bot-api/v1/agents/mira/avatar',
      shortDescription: 'Sales',
      isDefault: true,
    });
    expect(result.agents[1]).toMatchObject({ name: 'tom', avatarUrl: null, isDefault: false, archetype: 'facilitator' });
  });

  it('carries the server notice when there is no default agent', async () => {
    getAgentDirectory.mockResolvedValue({
      channel: 'teams',
      agents: [],
      default_agent: { slug: null, notice: { code: 'no_agent', text: 'No agent is set up here.' } },
    });
    const result = await fetchAvailableAgents({ channel: 'teams' });
    expect(getAgentDirectory).toHaveBeenCalledWith('teams');
    expect(result.defaultSlug).toBeNull();
    expect(result.defaultNotice).toBe('No agent is set up here.');
  });
});
