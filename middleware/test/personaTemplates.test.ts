import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  PERSONA_TEMPLATES,
  getPersonaTemplate,
  type PersonaTemplateId,
} from '../src/plugins/builder/personaTemplates.ts';

describe('PERSONA_TEMPLATES registry (issue #53)', () => {
  it('ships 6 archetypes', () => {
    assert.equal(PERSONA_TEMPLATES.length, 6);
    const ids = PERSONA_TEMPLATES.map((t) => t.id).sort();
    assert.deepEqual(ids, [
      'content-marketing',
      'customer-service',
      'research-analyst',
      'sales-dev',
      'software-engineer',
      'team-lead',
    ]);
  });

  it('every template has all 12 axes set as numbers in [0, 100]', () => {
    const expected: (keyof PersonaTemplate['axes'])[] = [
      'formality',
      'directness',
      'warmth',
      'humor',
      'sarcasm',
      'conciseness',
      'proactivity',
      'autonomy',
      'risk_tolerance',
      'creativity',
      'drama',
      'philosophy',
    ];
    for (const t of PERSONA_TEMPLATES) {
      for (const axis of expected) {
        const v = t.axes[axis];
        assert.equal(typeof v, 'number', `${t.id}.${axis} not number`);
        assert.ok(v >= 0 && v <= 100, `${t.id}.${axis}: ${v} out of range`);
      }
    }
  });

  it('every template has labelKey == "template.<id>"', () => {
    for (const t of PERSONA_TEMPLATES) {
      assert.equal(t.labelKey, `template.${t.id}`);
    }
  });

  it('every template has non-empty description + identity + suggested_skill', () => {
    for (const t of PERSONA_TEMPLATES) {
      assert.ok(t.description.length > 0, `${t.id}: empty description`);
      assert.ok(t.identity, `${t.id}: missing identity`);
      assert.ok(t.identity!.creature.length > 0);
      assert.ok(t.identity!.vibe.length > 0);
      assert.ok(t.suggested_skill, `${t.id}: missing suggested_skill`);
      assert.ok(t.suggested_skill!.role.length > 0);
      assert.ok(t.suggested_skill!.tonality.length > 0);
    }
  });

  it('snapshot — customer-service axes verbatim from kemia', () => {
    const cs = getPersonaTemplate('customer-service');
    assert.ok(cs);
    assert.deepEqual(cs.axes, {
      formality: 75,
      directness: 30,
      warmth: 85,
      humor: 20,
      sarcasm: 0,
      conciseness: 40,
      proactivity: 30,
      autonomy: 20,
      risk_tolerance: 15,
      creativity: 25,
      drama: 10,
      philosophy: 5,
    });
    assert.equal(cs.identity?.creature, 'Assistent');
    assert.equal(cs.suggested_skill?.role, 'Customer Service Agent');
  });

  it('snapshot — software-engineer is the most direct + concise', () => {
    const eng = getPersonaTemplate('software-engineer');
    assert.ok(eng);
    assert.equal(eng.axes.directness, 80);
    assert.equal(eng.axes.conciseness, 80);
  });
});

describe('getPersonaTemplate', () => {
  it('returns undefined for unknown id', () => {
    assert.equal(getPersonaTemplate('does-not-exist'), undefined);
  });

  it('returns the template for a valid id', () => {
    const t = getPersonaTemplate('research-analyst');
    assert.ok(t);
    assert.equal(t.id, 'research-analyst');
    assert.equal(t.axes.formality, 80);
  });

  it('id literal narrows to PersonaTemplateId', () => {
    const id: PersonaTemplateId = 'team-lead';
    assert.ok(getPersonaTemplate(id));
  });
});

// Local re-import to keep the test file self-contained for the axis-keys assertion.
type PersonaTemplate = (typeof PERSONA_TEMPLATES)[number];
