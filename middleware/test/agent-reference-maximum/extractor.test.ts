import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { extractFromNote } from '../../packages/agent-reference-maximum/extractor.js';

describe('agent-reference / extractor (OB-29-2)', () => {
  it('extracts Person:<Name> mentions', () => {
    const r = extractFromNote({
      body: 'Person:Marcel hat Theme F gut umgesetzt',
      noteId: 'n1',
    });
    assert.equal(r.entities.length, 1);
    assert.equal(r.entities[0]!.system, 'personal-notes');
    assert.equal(r.entities[0]!.model, 'Person');
    assert.equal(r.entities[0]!.id, 'marcel');
    assert.equal(r.entities[0]!.displayName, 'Marcel');
  });

  it('extracts Person:<Vorname Nachname> (two-word)', () => {
    const r = extractFromNote({
      body: 'Person:Anna Müller war beim Termin',
      noteId: 'n2',
    });
    assert.equal(r.entities.length, 1);
    assert.equal(r.entities[0]!.id, 'anna-mueller');
    assert.equal(r.entities[0]!.displayName, 'Anna Müller');
  });

  it('extracts Topic: prefix and #hashtags', () => {
    const r = extractFromNote({
      body: 'Topic:ThemeF + #builder-hardening',
      noteId: 'n3',
    });
    assert.equal(r.entities.length, 2);
    const ids = r.entities.map((e) => e.id).sort();
    assert.deepEqual(ids, ['builder-hardening', 'themef']);
    for (const e of r.entities) {
      assert.equal(e.model, 'Topic');
    }
  });

  it('deduplicates repeated mentions', () => {
    const r = extractFromNote({
      body: 'Person:Marcel und nochmal Person:Marcel im selben Satz',
      noteId: 'n4',
    });
    assert.equal(r.entities.length, 1);
  });

  it('produces a fact summarizing mentions when entities exist', () => {
    const r = extractFromNote({
      body: 'Person:Marcel + Topic:ThemeG',
      noteId: 'n5',
    });
    assert.equal(r.facts.length, 1);
    assert.equal(r.facts[0]!.mentionedEntityIds.length, 2);
    assert.match(r.facts[0]!.summary, /note\(n5\) mentions 2 entities/);
  });

  it('returns no facts when no entities matched', () => {
    const r = extractFromNote({
      body: 'plain text without any tagged entities',
      noteId: 'n6',
    });
    assert.equal(r.entities.length, 0);
    assert.equal(r.facts.length, 0);
  });

  it('ignores ambiguous mentions (no Person: prefix, no #)', () => {
    const r = extractFromNote({
      body: 'Marcel and Anna are working on something',
      noteId: 'n7',
    });
    assert.equal(r.entities.length, 0);
  });

  it('is deterministic + idempotent', () => {
    const r1 = extractFromNote({
      body: 'Person:Bob #foo',
      noteId: 'n8',
    });
    const r2 = extractFromNote({
      body: 'Person:Bob #foo',
      noteId: 'n8',
    });
    assert.deepEqual(r1, r2);
  });
});
