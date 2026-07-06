import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { EventCatalogRegistry, eventEmitIds } from '../src/platform/eventCatalogRegistry.js';
import { DefaultChannelRegistry } from '../src/channels/channelRegistry.js';

// Conductor real-world P1a — a CHANNEL plugin (e.g. Teams) declaring `event_emit` capabilities must
// have them registered in the event catalog on activation, exactly like the tool/dynamic runtimes,
// so `ctx.events.emit(...)` passes the deny-by-default gate and the events surface as Conductor
// triggers. The channel activation path was the one runtime missing this. These tests drive the real
// `DefaultChannelRegistry.activate`/`deactivate` so reverting the production wiring fails them.

// A Teams-shaped channel manifest (schema_version "1") with the new event-emit declarations. The
// `capabilities[].event_emit` objects are what `eventEmitIds` reads off the RAW manifest doc.
const teamsManifest = {
  schema_version: '1',
  identity: { id: '@omadia/channel-teams', kind: 'channel', domain: 'channel.teams' },
  capabilities: [
    { id: 'teams.message.posted', event_emit: true },
    { id: 'teams.mention', event_emit: true },
    { id: 'teams.reaction.added', event_emit: true },
    { id: 'teams.member.added', event_emit: false }, // declared but not an emitter → ignored
  ],
};

const TEAMS_ID = '@omadia/channel-teams';

// Minimal stub deps for DefaultChannelRegistry. activate() builds a real PluginContext via
// createPluginContext (most accessors are lazy) then calls the resolved plugin's activate(); the
// fake plugin is a no-op handle, so only construction-time deref of catalog/serviceRegistry matters.
function makeRegistry(catalog: EventCatalogRegistry): DefaultChannelRegistry {
  const noop = (): void => undefined;
  const unsub = (): (() => void) => () => undefined;
  const entry = {
    plugin: {
      kind: 'channel',
      domain: 'channel.teams',
      depends_on: [],
      permissions_summary: {},
      setup_fields: [],
      integrations_summary: [],
      provides: [],
      requires: [],
      jobs: [],
    },
    manifest: teamsManifest,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deps: any = {
    catalog: { get: () => entry, has: () => true, list: () => [entry] },
    installedRegistry: { list: () => [], get: () => entry },
    vault: { get: noop, set: noop, list: () => [] },
    serviceRegistry: { get: () => undefined, has: () => false, provide: unsub, replace: unsub },
    nativeToolRegistry: { register: noop, unregister: noop, list: () => [] },
    pluginRouteRegistry: { register: noop, deactivate: noop },
    notificationRouter: { registerChannel: unsub },
    uiRouteCatalog: { disposeBySource: noop },
    jobScheduler: { stopForPlugin: noop },
    pluginStatusRegistry: { clear: noop },
    eventCatalogRegistry: catalog,
    resolver: {
      resolve: async () => ({ activate: async () => ({ close: async () => undefined }) }),
      invalidate: noop,
    },
    coreApi: { log: noop, registerRoute: noop, registerRouter: noop },
    routes: { setActive: noop, deactivateChannel: noop },
    webSockets: { setActive: noop, deactivateChannel: noop },
  };
  return new DefaultChannelRegistry(deps);
}

describe('eventEmitIds (Teams manifest shape)', () => {
  it('extracts only the event_emit:true capability ids from a channel manifest', () => {
    assert.deepEqual(eventEmitIds(teamsManifest).sort(), [
      'teams.mention',
      'teams.message.posted',
      'teams.reaction.added',
    ]);
  });
});

describe('DefaultChannelRegistry event-emit catalog wiring (P1a)', () => {
  it('activate registers the channel’s declared events → emit allowed (deny-by-default)', async () => {
    const catalog = new EventCatalogRegistry();
    const reg = makeRegistry(catalog);
    await reg.activate(TEAMS_ID);

    assert.equal(catalog.has('teams.message.posted'), true);
    assert.equal(catalog.allows(TEAMS_ID, 'teams.message.posted'), true); // proves register wiring
    assert.equal(catalog.allows('@omadia/other', 'teams.message.posted'), false); // deny-by-default
    assert.equal(catalog.allows(TEAMS_ID, 'teams.member.added'), false); // event_emit:false ignored
  });

  it('deactivate unregisters the channel’s events from the catalog', async () => {
    const catalog = new EventCatalogRegistry();
    const reg = makeRegistry(catalog);
    await reg.activate(TEAMS_ID);
    await reg.deactivate(TEAMS_ID);

    assert.equal(catalog.has('teams.message.posted'), false); // proves unregister wiring
    assert.equal(catalog.allows(TEAMS_ID, 'teams.message.posted'), false);
    assert.equal(catalog.byPluginId()[TEAMS_ID], undefined);
  });
});
