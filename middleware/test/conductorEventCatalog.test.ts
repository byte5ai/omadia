import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { EventCatalogRegistry, eventEmitIds } from '../src/platform/eventCatalogRegistry.js';

// Conductor US4 (connector half) — the event-emit capability catalog + deny-by-default.

describe('eventEmitIds', () => {
  it('extracts capability ids declaring event_emit:true, ignoring everything else', () => {
    const manifest = {
      capabilities: [
        { id: 'github.pull_request.merged', event_emit: true },
        { id: 'github.issue.opened', event_emit: true },
        { id: 'some.canvas', canvas_output: true }, // not an event
        { id: 'no.flag' }, // no event_emit
        { event_emit: true }, // no id
        'garbage',
      ],
    };
    assert.deepEqual(eventEmitIds(manifest).sort(), ['github.issue.opened', 'github.pull_request.merged']);
  });

  it('returns [] for a manifest with no capabilities', () => {
    assert.deepEqual(eventEmitIds({}), []);
    assert.deepEqual(eventEmitIds(null), []);
    assert.deepEqual(eventEmitIds({ capabilities: 'nope' }), []);
  });
});

describe('EventCatalogRegistry', () => {
  it('registers, lists, and resolves catalog membership per plugin', () => {
    const reg = new EventCatalogRegistry();
    reg.register('plugin-a', ['a.one', 'a.two']);
    reg.register('plugin-b', ['b.one']);

    assert.deepEqual(reg.list(), ['a.one', 'a.two', 'b.one']); // sorted union
    assert.equal(reg.has('a.one'), true);
    assert.equal(reg.has('missing'), false);
    assert.deepEqual(reg.byPluginId(), { 'plugin-a': ['a.one', 'a.two'], 'plugin-b': ['b.one'] });
  });

  it('enforces deny-by-default per plugin (allows only the declaring plugin)', () => {
    const reg = new EventCatalogRegistry();
    reg.register('plugin-a', ['a.one']);
    assert.equal(reg.allows('plugin-a', 'a.one'), true);
    assert.equal(reg.allows('plugin-a', 'b.one'), false); // not declared by a
    assert.equal(reg.allows('plugin-b', 'a.one'), false); // b can't emit a's event
    assert.equal(reg.allows('unknown', 'a.one'), false);
  });

  it('unregister (and empty register) removes a plugin from the catalog', () => {
    const reg = new EventCatalogRegistry();
    reg.register('plugin-a', ['a.one']);
    reg.unregister('plugin-a');
    assert.equal(reg.has('a.one'), false);
    reg.register('plugin-a', ['a.one']);
    reg.register('plugin-a', []); // empty => delete
    assert.equal(reg.allows('plugin-a', 'a.one'), false);
  });
});
