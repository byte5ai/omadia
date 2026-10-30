import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { PeopleDirectoryProvider } from '@omadia/channel-sdk';

import { PEOPLE_SEARCH_MAX_LIMIT, PeopleDirectoryRegistry } from '../src/channels/peopleDirectoryRegistry.js';

// Kernel people-directory registry — one provider per channel type, partiality
// preserved, plugin data sanitized at the boundary.

function provider(
  channelType: string,
  people: Array<{ principalRef: string; displayName: string; email?: string }>,
  opts: { partial?: boolean } = {},
): PeopleDirectoryProvider {
  return {
    channelType,
    search: async () => ({ outcome: 'resolved', people, partial: opts.partial ?? false }),
  };
}

describe('PeopleDirectoryRegistry', () => {
  it('registers one provider per channel type and lists types sorted', () => {
    const r = new PeopleDirectoryRegistry();
    r.register('plugin-teams', provider('teams', []));
    r.register('plugin-slack', provider('slack', []));
    assert.deepEqual(r.types(), ['slack', 'teams']);
  });

  it('rejects a foreign replace but allows the owner to re-register', () => {
    const r = new PeopleDirectoryRegistry();
    r.register('plugin-teams', provider('teams', []));
    assert.throws(() => r.register('evil', provider('teams', [])), /already owned by channel 'plugin-teams'/);
    r.register('plugin-teams', provider('teams', [{ principalRef: 'a@x.io', displayName: 'A' }]));
    assert.deepEqual(r.types(), ['teams']);
  });

  it('unregisterChannel drops exactly that channel\'s providers (idempotent)', () => {
    const r = new PeopleDirectoryRegistry();
    r.register('plugin-teams', provider('teams', []));
    r.register('plugin-slack', provider('slack', []));
    r.unregisterChannel('plugin-teams');
    r.unregisterChannel('plugin-teams');
    assert.deepEqual(r.types(), ['slack']);
  });

  it('with zero providers resolves to an empty, non-partial result', async () => {
    const r = new PeopleDirectoryRegistry();
    assert.deepEqual(await r.search('ter', { limit: 10 }), { people: [], partial: false, sources: [] });
  });

  it('unions providers, annotates channelType, canonicalizes + de-duplicates per (channel, ref)', async () => {
    const r = new PeopleDirectoryRegistry();
    r.register('plugin-teams', provider('teams', [
      { principalRef: ' Teresita.Biel@Byte5.de ', displayName: 'Teresita Biel' },
      { principalRef: 'teresita.biel@byte5.de', displayName: 'Teresita Biel (dup)' },
    ]));
    r.register('plugin-slack', provider('slack', [
      { principalRef: 'teresita.biel@byte5.de', displayName: 'Teresita Biel' },
      { principalRef: 'U123', displayName: 'Tero Bielefeld', email: 'Tero@Byte5.de' },
    ]));
    const res = await r.search('ter', { limit: 10 });
    assert.equal(res.partial, false);
    assert.deepEqual(
      res.people.map((p) => [p.channelType, p.principalRef, p.email]),
      [
        ['teams', 'teresita.biel@byte5.de', undefined],
        ['slack', 'teresita.biel@byte5.de', undefined], // same person, other channel — the operator picks the route
        ['slack', 'u123', 'tero@byte5.de'],
      ],
    );
  });

  it('a hanging provider times out into unavailable/partial instead of stalling the search', async () => {
    const r = new PeopleDirectoryRegistry(() => undefined, 20);
    r.register('plugin-teams', { channelType: 'teams', search: () => new Promise(() => undefined) });
    r.register('plugin-slack', provider('slack', [{ principalRef: 'u1', displayName: 'U One' }]));
    const res = await r.search('u', { limit: 10 });
    assert.equal(res.partial, true);
    assert.deepEqual(res.people.map((p) => p.principalRef), ['u1']);
    const teams = res.sources.find((s) => s.channelType === 'teams')?.lookup;
    assert.equal(teams?.outcome, 'unavailable');
  });

  it('tolerates garbage plugin data (non-string optional fields, non-array people) without failing the search', async () => {
    const r = new PeopleDirectoryRegistry();
    r.register('plugin-teams', {
      channelType: 'teams',
      search: async () => ({ outcome: 'resolved', partial: false, people: [
        { principalRef: 'a@x.io', displayName: 'A', email: 42, hint: { nope: true } } as unknown as { principalRef: string; displayName: string },
        null as unknown as { principalRef: string; displayName: string },
      ] }),
    });
    r.register('plugin-slack', { channelType: 'slack', search: async () => ({ outcome: 'resolved', partial: false, people: 'nope' as unknown as [] }) });
    r.register('plugin-discord', { channelType: 'discord', search: async () => undefined as unknown as never });
    r.register('plugin-telegram', { channelType: 'telegram', search: async () => ({ outcome: 'weird' }) as unknown as never });
    r.register('plugin-whatsapp', { channelType: 'whatsapp', search: async () => ({ outcome: 'unavailable', code: 'nope' }) as unknown as never });
    const res = await r.search('a', { limit: 10 });
    assert.equal(res.sources.filter((s) => s.lookup.outcome === 'unavailable').length, 4, 'non-array people, undefined, unknown outcome and off-contract unavailable are all unavailable');
    const wa = res.sources.find((s) => s.channelType === 'whatsapp')?.lookup;
    assert.equal(wa?.outcome === 'unavailable' ? wa.code : '', 'source_error', 'an off-contract code is normalized, not passed through');
    assert.deepEqual(res.people.map((p) => [p.principalRef, p.email, p.hint]), [['a@x.io', undefined, undefined]]);
    assert.equal(res.partial, true, 'a provider resolving to undefined is unavailable, not a crash');
  });

  it('a throwing provider marks the result partial and is reported as unavailable', async () => {
    const r = new PeopleDirectoryRegistry();
    r.register('plugin-teams', { channelType: 'teams', search: async () => { throw new Error('graph 503'); } });
    r.register('plugin-slack', provider('slack', [{ principalRef: 'u1', displayName: 'U One' }]));
    const res = await r.search('u', { limit: 10 });
    assert.equal(res.partial, true);
    assert.equal(res.people.length, 1);
    const teams = res.sources.find((s) => s.channelType === 'teams');
    assert.equal(teams?.lookup.outcome, 'unavailable');
    assert.equal(teams?.lookup.outcome === 'unavailable' ? teams.lookup.code : '', 'source_error');
  });

  it('an unavailable provider sets partial without affecting other sources', async () => {
    const r = new PeopleDirectoryRegistry();
    r.register('plugin-teams', {
      channelType: 'teams',
      search: async () => ({ outcome: 'unavailable', code: 'not_configured', message: 'no User.Read.All' }),
    });
    r.register('plugin-slack', provider('slack', [{ principalRef: 'u1', displayName: 'U One' }]));
    const res = await r.search('u', { limit: 10 });
    assert.equal(res.partial, true);
    assert.deepEqual(res.people.map((p) => p.principalRef), ['u1']);
  });

  it('a provider answering partial:true propagates partiality', async () => {
    const r = new PeopleDirectoryRegistry();
    r.register('plugin-teams', provider('teams', [{ principalRef: 'a@x.io', displayName: 'A' }], { partial: true }));
    assert.equal((await r.search('a', { limit: 10 })).partial, true);
  });

  it('caps the union at limit and at the hard ceiling', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ principalRef: `p${String(i)}@x.io`, displayName: `P ${String(i)}` }));
    const r = new PeopleDirectoryRegistry();
    r.register('plugin-teams', provider('teams', many));
    assert.equal((await r.search('p', { limit: 3 })).people.length, 3);
    assert.equal((await r.search('p', { limit: 999 })).people.length, PEOPLE_SEARCH_MAX_LIMIT);
  });

  it('filters to one channel type when asked', async () => {
    const r = new PeopleDirectoryRegistry();
    r.register('plugin-teams', provider('teams', [{ principalRef: 't@x.io', displayName: 'T' }]));
    r.register('plugin-slack', provider('slack', [{ principalRef: 's@x.io', displayName: 'S' }]));
    const res = await r.search('x', { limit: 10, channelType: 'slack' });
    assert.deepEqual(res.people.map((p) => p.principalRef), ['s@x.io']);
    assert.equal(res.sources.length, 1);
  });

  it('drops entries whose ref is empty or contains whitespace (misrouting guard)', async () => {
    const r = new PeopleDirectoryRegistry();
    r.register('plugin-teams', provider('teams', [
      { principalRef: '   ', displayName: 'Blank' },
      { principalRef: 'Teresita Biel', displayName: 'Name as ref' },
      { principalRef: 'ok@x.io', displayName: '   ' },
      { principalRef: 'ok@x.io', displayName: 'Ok' },
    ]));
    const res = await r.search('x', { limit: 10 });
    assert.deepEqual(res.people.map((p) => p.principalRef), ['ok@x.io']);
  });
});
