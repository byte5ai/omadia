/**
 * Canvas-output autodiscovery (declare → resolve → derive).
 *
 * The registry is the kernel-side resolve step: dynamicAgentRuntime registers
 * the capability ids a plugin's manifest declares with `canvas_output: true`,
 * the ui-orchestrator derives its sentinel allow-set from it lazily. These
 * tests pin the extraction tolerance (permissive manifests) and the
 * register/unregister lifecycle including hot-upgrade overwrite.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CanvasOutputRegistry,
  canvasOutputToolIds,
} from '../src/platform/canvasOutputRegistry.js';

test('canvasOutputToolIds extracts only capabilities declaring canvas_output: true', () => {
  const manifest = {
    capabilities: [
      { id: 'x_studio_show_wizard', canvas_output: true },
      { id: 'x_studio_save_draft' }, // undeclared → not canvas output
      { id: 'weird_truthy', canvas_output: 'true' }, // string, not literal true
      { id: '', canvas_output: true }, // empty id ignored
      'not-an-object',
      { canvas_output: true }, // no id
    ],
  };
  assert.deepEqual(canvasOutputToolIds(manifest), ['x_studio_show_wizard']);
});

test('canvasOutputToolIds tolerates malformed manifests', () => {
  assert.deepEqual(canvasOutputToolIds(undefined), []);
  assert.deepEqual(canvasOutputToolIds(null), []);
  assert.deepEqual(canvasOutputToolIds('yaml gone wrong'), []);
  assert.deepEqual(canvasOutputToolIds({ capabilities: 'nope' }), []);
  assert.deepEqual(canvasOutputToolIds({}), []);
});

test('registry register/has/unregister lifecycle', () => {
  const reg = new CanvasOutputRegistry();
  assert.equal(reg.has('x_studio_show_wizard'), false);

  reg.register('@omadia/agent-x-studio', ['x_studio_show_wizard', 'x_studio_list_drafts']);
  reg.register('@omadia/agent-other', ['other_tool']);
  assert.equal(reg.has('x_studio_show_wizard'), true);
  assert.equal(reg.has('other_tool'), true);
  assert.equal(reg.has('x_studio_save_draft'), false);
  assert.deepEqual(reg.list(), ['other_tool', 'x_studio_list_drafts', 'x_studio_show_wizard']);

  reg.unregister('@omadia/agent-x-studio');
  assert.equal(reg.has('x_studio_show_wizard'), false);
  assert.equal(reg.has('other_tool'), true);
});

test('hot-upgrade overwrites a plugin registration instead of accumulating', () => {
  const reg = new CanvasOutputRegistry();
  reg.register('@omadia/agent-x-studio', ['old_tool']);
  reg.register('@omadia/agent-x-studio', ['new_tool']);
  assert.equal(reg.has('old_tool'), false);
  assert.equal(reg.has('new_tool'), true);
});

test('registering an empty id list clears the plugin entry', () => {
  const reg = new CanvasOutputRegistry();
  reg.register('@omadia/agent-x-studio', ['a_tool']);
  reg.register('@omadia/agent-x-studio', []);
  assert.equal(reg.has('a_tool'), false);
});
