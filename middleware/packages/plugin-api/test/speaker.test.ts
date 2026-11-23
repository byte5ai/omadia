import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMISSION_TYPES,
  SYSTEM_NOTICE_CODES,
  SYSTEM_SPEAKER,
  isAgentSpeaker,
  isSystemSpeaker,
  type AgentSpeaker,
} from '../src/speaker.js';

const mira: AgentSpeaker = {
  kind: 'agent',
  agentId: '00000000-0000-0000-0000-000000000001',
  slug: 'mira',
  displayName: 'Mira',
};

test('the emission types are exactly the four of spec 2042 §5.5', () => {
  assert.deepEqual([...EMISSION_TYPES], ['prose', 'template', 'data', 'system']);
});

test('the system speaker is one frozen value with no name of its own', () => {
  assert.deepEqual(SYSTEM_SPEAKER, { kind: 'system' });
  assert.ok(Object.isFrozen(SYSTEM_SPEAKER));
});

test('speaker guards tell an agent from the management layer', () => {
  assert.equal(isAgentSpeaker(mira), true);
  assert.equal(isSystemSpeaker(mira), false);
  assert.equal(isAgentSpeaker(SYSTEM_SPEAKER), false);
  assert.equal(isSystemSpeaker(SYSTEM_SPEAKER), true);
  assert.equal(isAgentSpeaker(undefined), false);
});

test('notice codes are unique', () => {
  assert.equal(new Set(SYSTEM_NOTICE_CODES).size, SYSTEM_NOTICE_CODES.length);
});
