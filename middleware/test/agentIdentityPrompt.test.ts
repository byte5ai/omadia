/**
 * #914 follow-up — an agent's identity compiled into its system prompt.
 *
 * Four controls, one prompt. What is worth pinning is not the wording of the
 * sections (their own compilers own that, and their own suites test it) but
 * the ASSEMBLY: which sections appear, in what order, and when the whole
 * thing is nothing at all.
 *
 * The order is a contract, not a preference. `[instructions, persona,
 * boundaries, sycophancy]` mirrors `dynamicAgentRuntime`'s section order for
 * sub-agents — who you are, how you sound, what you must not do, how not to
 * flatter. A prompt that put limits before character would read as an agent
 * apologising before it introduces itself.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  composeAgentIdentityPrompt,
  inferFamilyFromModel,
} from '../src/services/agentIdentityPrompt.js';

const EMPTY = {
  instructions: null,
  persona: null,
  quality: null,
  family: 'sonnet' as const,
};

describe('agent identity → system prompt (#914)', () => {
  it('compiles to nothing when nothing is authored', () => {
    const out = composeAgentIdentityPrompt(EMPTY);
    // `null`, not `''`: the caller stores it, and NULL is what makes the
    // platform-wide assistant identity apply unchanged.
    assert.equal(out.text, null);
    assert.deepEqual(out.droppedBoundaryPresets, []);
  });

  it('compiles to nothing when the persona is all-neutral and empty', () => {
    const out = composeAgentIdentityPrompt({
      ...EMPTY,
      persona: { axes: { directness: 50, warmth: 50 } },
      quality: { boundaries: { presets: [], custom: [] } },
    });
    assert.equal(
      out.text,
      null,
      'axes at the family default say nothing the model does not already do',
    );
  });

  it('carries the operator text through verbatim', () => {
    const out = composeAgentIdentityPrompt({
      ...EMPTY,
      instructions: '  You are the sales agent.  ',
    });
    assert.equal(out.text, 'You are the sales agent.');
  });

  it('assembles the sections in the documented order', () => {
    const out = composeAgentIdentityPrompt({
      instructions: 'You are the sales agent.',
      persona: {
        // Far enough from the Sonnet baseline to be emitted at all.
        axes: { directness: 95, sarcasm: 95 },
        custom_notes: 'Antworte auf Deutsch.',
      },
      quality: {
        sycophancy: 'high',
        boundaries: { presets: ['no-pii'], custom: ['Never quote prices.'] },
      },
      family: 'sonnet',
    });
    const text = out.text ?? '';

    const instructionsAt = text.indexOf('You are the sales agent.');
    const personaAt = text.indexOf('<persona>');
    const boundariesAt = text.indexOf('## Boundaries');
    const sycophancyAt = text.toLowerCase().lastIndexOf('sycophancy');

    assert.ok(instructionsAt >= 0, 'instructions present');
    assert.ok(personaAt > instructionsAt, 'persona follows the instructions');
    assert.ok(boundariesAt > personaAt, 'boundaries follow the persona');
    assert.ok(
      sycophancyAt > boundariesAt,
      'the anti-flattery guard closes the prompt',
    );
    // The operator's own note rides inside the persona section, not as a
    // fifth block — that is where its compiler puts it.
    assert.ok(text.includes('Antworte auf Deutsch.'));
    assert.ok(text.includes('Never quote prices.'));
  });

  it('reports boundary presets it could not resolve', () => {
    const out = composeAgentIdentityPrompt({
      ...EMPTY,
      quality: {
        boundaries: { presets: ['no-pii', 'from-the-future'], custom: [] },
      },
    });
    assert.deepEqual(out.droppedBoundaryPresets, ['from-the-future']);
    // The rules that DO resolve still apply — one unknown id does not void
    // the section.
    assert.ok((out.text ?? '').includes('## Boundaries'));
  });

  it('emits different traits for different model families', () => {
    const persona = { axes: { conciseness: 85 } };
    const sonnet = composeAgentIdentityPrompt({
      ...EMPTY,
      persona,
      family: 'sonnet',
    });
    const haiku = composeAgentIdentityPrompt({
      ...EMPTY,
      persona,
      family: 'haiku',
    });
    // Haiku is already terse; the same slider therefore has less to say
    // about it. This is the whole reason the family is stored alongside the
    // compiled prompt.
    assert.notEqual(sonnet.text, haiku.text);
  });

  it('maps model ids onto the three families, defaulting to sonnet', () => {
    assert.equal(inferFamilyFromModel('claude-haiku-4-5'), 'haiku');
    assert.equal(inferFamilyFromModel('anthropic:claude-opus-5'), 'opus');
    assert.equal(inferFamilyFromModel('claude-sonnet-5'), 'sonnet');
    assert.equal(inferFamilyFromModel(''), 'sonnet');
    assert.equal(inferFamilyFromModel('gpt-5.4'), 'sonnet');
  });
});
