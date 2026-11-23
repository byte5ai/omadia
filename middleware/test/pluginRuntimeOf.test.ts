/**
 * #2088 — every manifest kind has a runtime.
 *
 * The update path and the deactivation path each had a `switch` over the kind
 * whose `default` was the agent runtime. Kind `archetype` was added to the
 * install path only: an update to an archetype version started the new
 * version as an agent plugin next to the running old one ("duplicate
 * provider", previous version kept), and an uninstall never stopped it.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { PLUGIN_KINDS } from '../src/api/admin-v1.js';
import { pluginRuntimeOf } from '../src/plugins/pluginRuntimeOf.js';

describe('#2088 runtime of a plugin kind', () => {
  it('maps every kind the manifest loader accepts', () => {
    const mapped = Object.fromEntries(PLUGIN_KINDS.map((kind) => [kind, pluginRuntimeOf(kind)]));
    assert.deepEqual(mapped, {
      integration: 'tool',
      tool: 'tool',
      skill: 'tool',
      channel: 'channel',
      model: 'tool',
      archetype: 'tool',
      'system-module': 'tool',
      'agent-template': 'tool',
      agent: 'none',
      extension: 'tool',
    });
  });

  it('runs no code for a plugin the catalog does not know', () => {
    assert.equal(pluginRuntimeOf(undefined), 'none');
  });

  it('the update and the deactivation path dispatch through it, not through a default branch', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const body = (start: string): string => {
      const from = source.indexOf(start);
      assert.ok(from > 0, `${start} not found`);
      return source.slice(from, from + 6_000);
    };
    for (const start of [
      'onInstalled: async (agentId) => {',
      'onPackageReady: async (agentId) => {',
      'onUninstall: async (agentId, reason) => {',
    ]) {
      const text = body(start);
      const dispatch = text.indexOf('switch (pluginRuntimeOf(');
      assert.ok(dispatch > 0, `${start} must switch on pluginRuntimeOf()`);
      const end = text.indexOf("case 'none':", dispatch);
      assert.ok(end > dispatch, `${start} has no branch for the retired agent kind`);
      assert.ok(!text.slice(dispatch, end + 40).includes('default:'), `${start} must not have a default runtime`);
    }
  });
});
