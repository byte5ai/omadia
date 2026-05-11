import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { composePersonaSection } from '../src/plugins/personaCompose.js';
import { FAMILY_DEFAULTS } from '../src/plugins/personaDelta.js';

/**
 * Phase 3 / OB-67 Slice 9 — XML <persona> section composer tests.
 */
describe('composePersonaSection', () => {
  it('returns empty string when persona is undefined', () => {
    assert.equal(composePersonaSection({ persona: undefined, family: 'sonnet' }), '');
  });

  it('returns empty string for all-neutral axes + no notes', () => {
    // value ~= family default → neutral
    const out = composePersonaSection({
      persona: { axes: { directness: FAMILY_DEFAULTS.sonnet.directness } },
      family: 'sonnet',
    });
    assert.equal(out, '');
  });

  it('emits only significant deltas (skips neutral)', () => {
    const out = composePersonaSection({
      persona: {
        axes: {
          // sonnet directness 55 → 60 = +5 (neutral, skip)
          directness: 60,
          // sonnet sarcasm 15 → 90 = +75 (strong, emit)
          sarcasm: 90,
        },
      },
      family: 'sonnet',
    });
    assert.match(out, /<persona>/);
    assert.match(out, /sarcasm:.*ironic/);
    assert.doesNotMatch(out, /directness:/);
    assert.match(out, /<\/persona>/);
  });

  it('renders a sarcasm-90 hotelagent the way a Builder operator would expect', () => {
    const out = composePersonaSection({
      persona: {
        axes: { sarcasm: 90, directness: 80, warmth: 20 },
        custom_notes: 'Antworte auf Deutsch wenn der User auf Deutsch schreibt.',
      },
      family: 'sonnet',
    });
    assert.match(out, /sarcasm:.*wry|sarcasm:.*ironic|sarcasm:.*biting/);
    assert.match(out, /directness:.*direct/);
    assert.match(out, /warmth:.*cool|warmth:.*distance/);
    assert.match(out, /Personal notes from the operator/);
    assert.match(out, /Antworte auf Deutsch/);
  });

  it('emits notes-only section when no axes are significant', () => {
    const out = composePersonaSection({
      persona: { custom_notes: 'Antworte stets auf Deutsch.' },
      family: 'sonnet',
    });
    assert.match(out, /<persona>/);
    assert.match(out, /Personal notes from the operator/);
    assert.match(out, /Antworte stets auf Deutsch\./);
    assert.doesNotMatch(out, /traits, relative/);
  });

  it('different families produce different output for the same axis value', () => {
    const sonnetOut = composePersonaSection({
      persona: { axes: { conciseness: 50 } },
      family: 'sonnet',
    });
    const haikuOut = composePersonaSection({
      persona: { axes: { conciseness: 50 } },
      family: 'haiku',
    });
    // Sonnet conciseness 45 → +5 = neutral → empty
    // Haiku conciseness 65 → -15 = neutral too (boundary)
    // → both empty in this exact configuration
    assert.equal(sonnetOut, '');
    assert.equal(haikuOut, '');

    // Move to a value that crosses for Haiku but not Sonnet:
    // value 30 → Sonnet -15 (neutral), Haiku -35 (strong)
    const sonnetOut2 = composePersonaSection({
      persona: { axes: { conciseness: 30 } },
      family: 'sonnet',
    });
    const haikuOut2 = composePersonaSection({
      persona: { axes: { conciseness: 30 } },
      family: 'haiku',
    });
    assert.equal(sonnetOut2, '');
    assert.match(haikuOut2, /conciseness:.*expansive|conciseness:.*more elaboration/);
  });

  it('determinism: same input → byte-identical output', () => {
    const input = {
      persona: { axes: { sarcasm: 80, directness: 75 }, custom_notes: 'note' },
      family: 'sonnet' as const,
    };
    assert.equal(
      composePersonaSection(input),
      composePersonaSection(input),
    );
  });

  it('trims custom_notes whitespace', () => {
    const out = composePersonaSection({
      persona: { custom_notes: '   leading and trailing   ' },
      family: 'sonnet',
    });
    assert.match(out, /^<persona>/);
    assert.match(out, /leading and trailing/);
    assert.doesNotMatch(out, / {3}leading/);
  });

  it('output is well-formed XML (single open + single close)', () => {
    const out = composePersonaSection({
      persona: { axes: { sarcasm: 90 }, custom_notes: 'note' },
      family: 'sonnet',
    });
    const opens = (out.match(/<persona>/g) ?? []).length;
    const closes = (out.match(/<\/persona>/g) ?? []).length;
    assert.equal(opens, 1);
    assert.equal(closes, 1);
  });
});
