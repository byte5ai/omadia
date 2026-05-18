import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  BASE_PROFILES,
  getBaseProfile,
  type BaseProfile,
  type PersonaFamilyId,
} from '../src/plugins/basePersonas.ts';

describe('basePersonas registry (issue #58)', () => {
  it('ships 13 family profiles (12 explicit + unknown fallback)', () => {
    assert.equal(Object.keys(BASE_PROFILES).length, 13);
    const expected: PersonaFamilyId[] = [
      'anthropic-claude',
      'openai-gpt',
      'google-gemini',
      'meta-llama',
      'mistral',
      'alibaba-qwen',
      'deepseek',
      'moonshot-kimi',
      'zhipu-glm',
      '01ai-yi',
      'google-gemma',
      'microsoft-phi',
      'unknown',
    ];
    for (const id of expected) {
      assert.ok(BASE_PROFILES[id], `missing profile: ${id}`);
    }
  });

  it('Claude carries qualitative-from-sources confidence + sources[]', () => {
    const claude = BASE_PROFILES['anthropic-claude'];
    assert.equal(claude.confidence, 'qualitative-from-sources');
    assert.ok(claude.sources.length >= 1, 'Claude must have at least one source URL');
    // Sanity: constitution + system-prompts release notes referenced in kemia
    assert.ok(claude.sources.some((s) => s.includes('claudes-constitution')));
  });

  it('GPT and Gemini also Tier A (qualitative-from-sources)', () => {
    assert.equal(BASE_PROFILES['openai-gpt'].confidence, 'qualitative-from-sources');
    assert.equal(BASE_PROFILES['google-gemini'].confidence, 'qualitative-from-sources');
  });

  it('open-weights families ship as Tier B (estimated)', () => {
    const tierB: PersonaFamilyId[] = [
      'meta-llama',
      'mistral',
      'alibaba-qwen',
      'deepseek',
      'moonshot-kimi',
      'zhipu-glm',
      '01ai-yi',
      'google-gemma',
      'microsoft-phi',
    ];
    for (const id of tierB) {
      assert.equal(BASE_PROFILES[id].confidence, 'estimated', `${id} must be estimated`);
    }
  });

  it('every profile has all 12 axis dimensions set as numbers', () => {
    const axes = [
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
    ] as const;
    for (const id of Object.keys(BASE_PROFILES) as PersonaFamilyId[]) {
      const p: BaseProfile = BASE_PROFILES[id];
      for (const axis of axes) {
        const v = p.dimensions[axis];
        assert.equal(typeof v, 'number', `${id}.${axis}: expected number, got ${v}`);
        assert.ok(v >= 0 && v <= 100, `${id}.${axis}: ${v} out of [0,100]`);
      }
    }
  });

  it('CN-policy families carry regulatoryConstraints', () => {
    const cn: PersonaFamilyId[] = ['alibaba-qwen', 'deepseek', 'moonshot-kimi', 'zhipu-glm', '01ai-yi'];
    for (const id of cn) {
      const p = BASE_PROFILES[id];
      assert.ok(
        p.regulatoryConstraints?.includes('cn-content-policy'),
        `${id} missing cn-content-policy constraint`,
      );
    }
  });

  it('every profile has a non-empty updatedAt (ISO date)', () => {
    for (const id of Object.keys(BASE_PROFILES) as PersonaFamilyId[]) {
      assert.match(BASE_PROFILES[id].updatedAt, /^\d{4}-\d{2}-\d{2}$/, `${id}.updatedAt`);
    }
  });
});

describe('getBaseProfile (issue #58)', () => {
  it('resolves known family ids', () => {
    assert.equal(getBaseProfile('anthropic-claude').family, 'anthropic-claude');
    assert.equal(getBaseProfile('openai-gpt').family, 'openai-gpt');
    assert.equal(getBaseProfile('mistral').family, 'mistral');
  });

  it('falls back to unknown profile for unrecognized id', () => {
    const p = getBaseProfile('does-not-exist-yet');
    assert.equal(p.family, 'unknown');
    assert.equal(p.confidence, 'estimated');
  });

  it('falls back for empty string', () => {
    assert.equal(getBaseProfile('').family, 'unknown');
  });
});
