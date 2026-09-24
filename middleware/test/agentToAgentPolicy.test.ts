/**
 * #1018 W0 — the agent-to-agent switches are AND-combined and deny-default.
 *
 * Both halves fail closed independently: an unrecognised agent mode reads
 * `'off'`, a missing policy row reads `false`, and only `'on'` AND `true`
 * opens the relay. Pinned here because the failure direction matters more
 * than the happy path — a rolling deploy that reads a newer value must not
 * switch peer talk ON.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AGENT_TO_AGENT_MODES,
  isAgentToAgentEnabled,
  parseAgentToAgentMode,
} from '../packages/harness-orchestrator/src/registry/agentToAgent.js';

test('parseAgentToAgentMode is deny-default', () => {
  assert.equal(parseAgentToAgentMode('on'), 'on');
  assert.equal(parseAgentToAgentMode('off'), 'off');
  assert.equal(parseAgentToAgentMode(null), 'off');
  assert.equal(parseAgentToAgentMode(undefined), 'off');
  assert.equal(parseAgentToAgentMode('ON'), 'off');
  assert.equal(parseAgentToAgentMode('enforce'), 'off');
  assert.deepEqual(AGENT_TO_AGENT_MODES, ['off', 'on']);
});

test('isAgentToAgentEnabled requires BOTH halves', () => {
  const policyOn = { agentToAgent: true };
  const policyOff = { agentToAgent: false };
  assert.equal(isAgentToAgentEnabled('on', policyOn), true);
  assert.equal(isAgentToAgentEnabled('on', policyOff), false);
  assert.equal(isAgentToAgentEnabled('on', undefined), false);
  assert.equal(isAgentToAgentEnabled('off', policyOn), false);
  assert.equal(isAgentToAgentEnabled(undefined, policyOn), false);
});
