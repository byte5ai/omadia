/**
 * #2088 — the archetype registry and the one question call sites ask.
 *
 * `archetypeOmits(agent, x)` replaces every "is this a facilitator?" that
 * decided whether something is allowed. The descriptor answers; an archetype
 * without one omits everything.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  ARCHETYPE_OMISSIONS,
  ArchetypeOmissionError,
  archetypeOf,
  archetypeOmits,
  assertArchetypeAllows,
  getArchetype,
  isArchetype,
  listArchetypes,
  parseArchetype,
  registerArchetype,
} from '../packages/harness-orchestrator/src/registry/archetype.js';
import {
  FacilitatorOmissionError,
  assertNotFacilitator,
  isFacilitatorKind,
  parseAgentKind,
} from '../packages/harness-orchestrator/src/registry/agentKind.js';

describe('agent archetypes', () => {
  it('standard is built in and omits nothing; the facilitator is seeded with every omission of spec 2043 §2.3', () => {
    assert.deepEqual(listArchetypes().map((d) => d.id).sort(), ['facilitator', 'standard']);
    assert.deepEqual(getArchetype('standard')?.omits, []);
    assert.deepEqual([...(getArchetype('facilitator')?.omits ?? [])].sort(), [...ARCHETYPE_OMISSIONS].sort());
    for (const omission of ARCHETYPE_OMISSIONS) {
      assert.equal(archetypeOmits({ archetype: 'standard' }, omission), false);
      assert.equal(archetypeOmits({ archetype: 'facilitator' }, omission), true);
      assert.ok(getArchetype('facilitator')?.omissionReasons?.[omission], `a reason for ${omission}`);
    }
    assert.equal(archetypeOmits(undefined, 'memory'), false, 'no agent, nothing to refuse');
  });

  it('reads the archetype, then the legacy kind, then standard', () => {
    assert.equal(archetypeOf({ archetype: 'facilitator', kind: 'facilitator' }), 'facilitator');
    assert.equal(archetypeOf({ kind: 'facilitator' }), 'facilitator', 'a row from before migration 0070');
    // The column default next to a kind the sync has not copied yet.
    assert.equal(archetypeOf({ archetype: 'standard', kind: 'facilitator' }), 'facilitator');
    assert.equal(archetypeOf({}), 'standard');
    assert.equal(archetypeOf(undefined), 'standard');
    assert.equal(parseArchetype(null, null), 'standard');
    assert.equal(parseArchetype('Not An Id', undefined), 'standard');
    assert.equal(isArchetype({ kind: 'facilitator' }, 'facilitator'), true);
    assert.equal(isArchetype(undefined, 'standard'), false);
  });

  it('an archetype nobody registered omits everything: it is never run as a standard agent', () => {
    const orphan = { slug: 'coach-1', archetype: 'coach' };
    for (const omission of ARCHETYPE_OMISSIONS) assert.equal(archetypeOmits(orphan, omission), true);
    assert.throws(
      () => assertArchetypeAllows(orphan, 'plugin_grant'),
      /agent "coach-1" has the archetype 'coach', which is not registered on this instance/,
    );
    // The legacy output value for it is `standard`; that is why nothing decides on `kind`.
    assert.equal(parseAgentKind(archetypeOf(orphan)), 'standard');
  });

  it('a registered descriptor decides, and removing it denies again', () => {
    const dispose = registerArchetype({
      id: 'coach',
      source: '@acme/archetype-coach',
      noun: 'a coach',
      omits: ['default_agent', 'memory'],
      omissionReasons: { memory: 'a coach keeps no memory' },
    });
    try {
      const coach = { slug: 'c', archetype: 'coach' };
      assert.equal(archetypeOmits(coach, 'memory'), true);
      assert.equal(archetypeOmits(coach, 'plugin_grant'), false);
      assert.doesNotThrow(() => assertArchetypeAllows(coach, 'plugin_grant'));
      assert.throws(() => assertArchetypeAllows(coach, 'memory'), /agent "c" is a coach: a coach keeps no memory/);
      assert.throws(
        () => assertArchetypeAllows(coach, 'default_agent'),
        /agent "c" is a coach: the archetype 'coach' omits default_agent/,
      );
    } finally {
      dispose();
    }
    assert.equal(getArchetype('coach'), undefined);
    assert.equal(archetypeOmits({ archetype: 'coach' }, 'plugin_grant'), true);
  });

  it('refuses to redefine standard, an invalid id and an unknown omission', () => {
    assert.throws(() => registerArchetype({ id: 'standard', source: 'x', noun: 'x', omits: ['memory'] }), /built in/);
    assert.throws(() => registerArchetype({ id: 'Coach!', source: 'x', noun: 'x', omits: [] }), /not valid/);
    assert.throws(
      () => registerArchetype({ id: 'coach', source: 'x', noun: 'x', omits: ['everything' as never] }),
      /unknown omissions: everything/,
    );
    assert.deepEqual(getArchetype('standard')?.omits, []);
  });

  it('the refusal keeps its wording, its code and the old names', () => {
    const mara = { slug: 'mara', archetype: 'facilitator' };
    let caught: unknown;
    try {
      assertArchetypeAllows(mara, 'memory');
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ArchetypeOmissionError);
    assert.ok(caught instanceof FacilitatorOmissionError, 'the old class name is the same class');
    assert.deepEqual(
      [caught.code, caught.omission, caught.agentSlug, caught.archetype],
      ['facilitator_omission', 'memory', 'mara', 'facilitator'],
    );
    assert.equal(
      caught.message,
      'agent "mara" is a facilitator: a facilitator has no general memory; its only memory is the record of each facilitation',
    );
    assert.throws(() => assertNotFacilitator({ slug: 'mara', kind: 'facilitator' }, 'consultation'), ArchetypeOmissionError);
    assert.equal(isFacilitatorKind({ archetype: 'facilitator' }), true);
    assert.doesNotThrow(() => assertArchetypeAllows({ slug: 'hr', archetype: 'standard' }, 'memory'));
  });
});
