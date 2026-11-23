import { describe, expect, it } from 'vitest';

import type { PluginCatalogEntryDto } from '../agents';
import { channelTypesOfCatalog } from '../channelTypes';

const entry = (over: Partial<PluginCatalogEntryDto>): PluginCatalogEntryDto =>
  ({
    id: 'x',
    name: 'x',
    kind: 'tool',
    version: '1.0.0',
    multi_instance: true,
    privacy_class: 'default',
    memory_reads: [],
    memory_writes: [],
    network_outbound: [],
    setup_fields: [],
    depends_on: [],
    ...over,
  }) as PluginCatalogEntryDto;

describe('channelTypesOfCatalog', () => {
  it('offers the channel types the server names, never a plugin id', () => {
    const types = channelTypesOfCatalog([
      entry({ id: '@omadia/channel-discord', kind: 'channel', channel_types: ['discord'] }),
      entry({ id: '@omadia/channel-teams', kind: 'channel', channel_types: ['teams'] }),
      entry({ id: '@omadia/channel-api', kind: 'channel', channel_types: ['@omadia/channel-api'] }),
      entry({ id: '@omadia/odoo', kind: 'tool' }),
    ]);
    expect(types).toEqual(['@omadia/channel-api', 'discord', 'teams']);
    expect(types).not.toContain('channel-discord');
  });

  it('offers nothing for a channel the server named no type for, and survives no catalog', () => {
    expect(channelTypesOfCatalog([entry({ id: '@omadia/channel-slack', kind: 'channel' })])).toEqual([]);
    expect(channelTypesOfCatalog(null)).toEqual([]);
  });
});
