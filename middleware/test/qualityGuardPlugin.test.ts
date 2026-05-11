import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  AgentOverridesMapSchema,
  BOUNDARY_SECTION_HEADING,
  ProfileQualityConfigSchema,
  SYCOPHANCY_SECTION_HEADING,
  SycophancyLevelSchema,
  createResponseGuardService,
  expandPresets,
  formatRulesBlock,
  knownBoundaryPresetIds,
  parseProfileQualityConfig,
  rulesForSycophancy,
} from '@omadia/plugin-quality-guard';
import {
  RESPONSE_GUARD_CAPABILITY,
  RESPONSE_GUARD_SERVICE_NAME,
  type ResponseGuardRequest,
  type ResponseGuardService,
} from '@omadia/plugin-api';

/**
 * Unit tests for the Quality-Guard plugin. The plugin is pure
 * string-formatting on top of a config-resolution layer, so the tests
 * exercise the public surface — `rulesForSycophancy`, `expandPresets`,
 * `formatRulesBlock`, the service factory's resolution rules, and the
 * Zod schemas — without booting a real PluginContext.
 */

// Minimal "no-op" defaults used by tests that don't touch resolution
const ZERO_DEFAULTS = {
  sycophancy: 'off' as const,
  boundaries: { presets: [] as readonly string[], custom: [] as readonly string[] },
};

const EMPTY_REQUEST: ResponseGuardRequest = {
  systemPrompt: 'Du bist der byte5 Assistent. (test stub)',
  messages: [],
};

// ---------------------------------------------------------------------------
// Sycophancy-level rules
// ---------------------------------------------------------------------------

describe('rulesForSycophancy', () => {
  it('returns no rules for level off', () => {
    assert.deepEqual(rulesForSycophancy('off'), []);
  });

  it('returns 2 rules for level low', () => {
    const rules = rulesForSycophancy('low');
    assert.equal(rules.length, 2);
  });

  it('returns 5 rules for level medium (low + medium-extra)', () => {
    const rules = rulesForSycophancy('medium');
    assert.equal(rules.length, 5);
  });

  it('returns 8 rules for level high (low + medium + high-extra)', () => {
    const rules = rulesForSycophancy('high');
    assert.equal(rules.length, 8);
  });

  it('escalates monotonically — each level is a strict superset of the lower', () => {
    const low = rulesForSycophancy('low');
    const medium = rulesForSycophancy('medium');
    const high = rulesForSycophancy('high');
    for (const r of low) assert.ok(medium.includes(r), `medium missing low rule: ${r}`);
    for (const r of medium) assert.ok(high.includes(r), `high missing medium rule: ${r}`);
  });

  it('never returns empty strings or duplicates inside a level', () => {
    for (const level of ['low', 'medium', 'high'] as const) {
      const rules = rulesForSycophancy(level);
      const set = new Set(rules);
      assert.equal(set.size, rules.length, `${level} has duplicates`);
      for (const r of rules) assert.ok(r.length > 0, `${level} has empty rule`);
    }
  });
});

// ---------------------------------------------------------------------------
// Boundary preset library
// ---------------------------------------------------------------------------

describe('boundary presets', () => {
  it('exposes a 10-id library', () => {
    assert.equal(knownBoundaryPresetIds().length, 10);
  });

  it('returns the wording for a known id', () => {
    const out = expandPresets(['no-financial-advice']);
    assert.equal(out.length, 1);
    assert.match(out[0] ?? '', /Steuer/);
  });

  it('drops unknown ids silently — does not throw', () => {
    const out = expandPresets(['no-such-preset', 'no-financial-advice']);
    assert.equal(out.length, 1);
  });

  it('preserves order of the input ids', () => {
    const out = expandPresets(['no-medical-advice', 'no-financial-advice']);
    assert.equal(out.length, 2);
    assert.match(out[0] ?? '', /Diagnose/);
    assert.match(out[1] ?? '', /Steuer/);
  });

  it('deduplicates repeated ids', () => {
    const out = expandPresets(['no-financial-advice', 'no-financial-advice']);
    assert.equal(out.length, 1);
  });

  it('returns the empty list for an empty input', () => {
    assert.deepEqual(expandPresets([]), []);
  });
});

// ---------------------------------------------------------------------------
// Format rules block
// ---------------------------------------------------------------------------

describe('formatRulesBlock', () => {
  it('returns empty string when no rules apply', () => {
    assert.equal(formatRulesBlock(ZERO_DEFAULTS), '');
  });

  it('emits the sycophancy heading when sycophancy is active', () => {
    const block = formatRulesBlock({
      sycophancy: 'low',
      boundaries: { presets: [], custom: [] },
    });
    assert.ok(block.includes(SYCOPHANCY_SECTION_HEADING));
  });

  it('emits the boundary heading when presets are active', () => {
    const block = formatRulesBlock({
      sycophancy: 'off',
      boundaries: { presets: ['no-pii-collection'], custom: [] },
    });
    assert.ok(block.includes(BOUNDARY_SECTION_HEADING));
  });

  it('appends custom boundaries verbatim into the boundary section', () => {
    const block = formatRulesBlock({
      sycophancy: 'off',
      boundaries: {
        presets: [],
        custom: ['Don\'t quote external news verbatim.'],
      },
    });
    assert.match(block, /Don't quote external news verbatim\./);
  });

  it('joins both sections with a blank-line separator', () => {
    const block = formatRulesBlock({
      sycophancy: 'low',
      boundaries: { presets: ['no-medical-advice'], custom: [] },
    });
    assert.ok(
      block.includes('\n\n'),
      'expected blank line between sycophancy and boundaries sections',
    );
  });

  it('skips empty/whitespace-only custom rules', () => {
    const block = formatRulesBlock({
      sycophancy: 'off',
      boundaries: { presets: [], custom: ['   ', '\t\t'] },
    });
    assert.equal(block, '');
  });
});

// ---------------------------------------------------------------------------
// Service factory — resolution rules
// ---------------------------------------------------------------------------

describe('createResponseGuardService — resolution', () => {
  it('publishes empty rules when defaults are off + no boundaries', async () => {
    const svc = createResponseGuardService({
      defaults: ZERO_DEFAULTS,
      agentOverrides: {},
    });
    const r = await svc.getRules(EMPTY_REQUEST);
    assert.equal(r.prependRules, '');
  });

  it('uses defaults when no profile + no agent override', async () => {
    const svc = createResponseGuardService({
      defaults: {
        sycophancy: 'medium',
        boundaries: { presets: [], custom: [] },
      },
      agentOverrides: {},
    });
    const r = await svc.getRules(EMPTY_REQUEST);
    assert.ok(r.prependRules.includes(SYCOPHANCY_SECTION_HEADING));
  });

  it('per-call profileQuality.sycophancy overrides the default', async () => {
    const svc = createResponseGuardService({
      defaults: {
        sycophancy: 'off',
        boundaries: { presets: [], custom: [] },
      },
      agentOverrides: {},
    });
    const r = await svc.getRules({
      ...EMPTY_REQUEST,
      profileQuality: { sycophancy: 'high' },
    });
    // High has 8 rules → block must contain ALL of them, including a
    // rule-fragment unique to the high level.
    assert.match(r.prependRules, /Devil's-Advocate/);
  });

  it('agent_overrides[agentId] overrides the default sycophancy', async () => {
    const svc = createResponseGuardService({
      defaults: {
        sycophancy: 'off',
        boundaries: { presets: [], custom: [] },
      },
      agentOverrides: { 'agent-seo-analyst': 'medium' },
    });
    const r = await svc.getRules({
      ...EMPTY_REQUEST,
      agentId: 'agent-seo-analyst',
    });
    assert.ok(r.prependRules.includes(SYCOPHANCY_SECTION_HEADING));
  });

  it('profileQuality wins over agent_overrides when both are set', async () => {
    const svc = createResponseGuardService({
      defaults: {
        sycophancy: 'off',
        boundaries: { presets: [], custom: [] },
      },
      agentOverrides: { 'agent-x': 'low' },
    });
    const r = await svc.getRules({
      ...EMPTY_REQUEST,
      agentId: 'agent-x',
      profileQuality: { sycophancy: 'high' },
    });
    // High-extra rule → presence proves 'high' won, not 'low'.
    assert.match(r.prependRules, /Devil's-Advocate/);
  });

  it('passes profile-level boundary presets through', async () => {
    const svc = createResponseGuardService({
      defaults: ZERO_DEFAULTS,
      agentOverrides: {},
    });
    const r = await svc.getRules({
      ...EMPTY_REQUEST,
      profileQuality: {
        boundaries: { presets: ['no-financial-advice'] },
      },
    });
    assert.match(r.prependRules, /Steuer/);
  });

  it('passes profile-level custom boundaries through verbatim', async () => {
    const svc = createResponseGuardService({
      defaults: ZERO_DEFAULTS,
      agentOverrides: {},
    });
    const r = await svc.getRules({
      ...EMPTY_REQUEST,
      profileQuality: {
        boundaries: { custom: ['Custom rule X with marker 9f3a-marker.'] },
      },
    });
    assert.match(r.prependRules, /9f3a-marker/);
  });

  it('returns a thenable promise that resolves to a string', () => {
    const svc: ResponseGuardService = createResponseGuardService({
      defaults: ZERO_DEFAULTS,
      agentOverrides: {},
    });
    const ret = svc.getRules(EMPTY_REQUEST);
    assert.ok(typeof ret.then === 'function', 'getRules must return a Promise');
  });
});

// ---------------------------------------------------------------------------
// Zod schemas (frontmatter validation)
// ---------------------------------------------------------------------------

describe('ProfileQualityConfigSchema', () => {
  it('accepts an empty object', () => {
    const r = ProfileQualityConfigSchema.safeParse({});
    assert.ok(r.success, 'empty object must validate');
  });

  it('accepts a valid sycophancy value', () => {
    const r = ProfileQualityConfigSchema.safeParse({ sycophancy: 'medium' });
    assert.ok(r.success);
  });

  it('rejects an invalid sycophancy enum value', () => {
    const r = ProfileQualityConfigSchema.safeParse({ sycophancy: 'extreme' });
    assert.ok(!r.success);
  });

  it('rejects unknown top-level fields (strict mode)', () => {
    const r = ProfileQualityConfigSchema.safeParse({
      sycophancy: 'off',
      typo_field: 'oops',
    });
    assert.ok(!r.success);
  });

  it('rejects unknown fields inside boundaries (strict mode)', () => {
    const r = ProfileQualityConfigSchema.safeParse({
      boundaries: { presets: [], typo: 'oops' },
    });
    assert.ok(!r.success);
  });
});

describe('SycophancyLevelSchema', () => {
  it('accepts the four canonical levels', () => {
    for (const level of ['off', 'low', 'medium', 'high'] as const) {
      assert.ok(SycophancyLevelSchema.safeParse(level).success, `${level}`);
    }
  });

  it('rejects bogus levels', () => {
    assert.ok(!SycophancyLevelSchema.safeParse('').success);
    assert.ok(!SycophancyLevelSchema.safeParse('LOW').success);
    assert.ok(!SycophancyLevelSchema.safeParse(null).success);
  });
});

describe('AgentOverridesMapSchema', () => {
  it('accepts a non-empty agentId → level map', () => {
    const r = AgentOverridesMapSchema.safeParse({
      'agent-x': 'medium',
      'agent-y': 'low',
    });
    assert.ok(r.success);
  });

  it('rejects an entry with an invalid level', () => {
    const r = AgentOverridesMapSchema.safeParse({
      'agent-x': 'extreme',
    });
    assert.ok(!r.success);
  });
});

// ---------------------------------------------------------------------------
// parseProfileQualityConfig — the helper exposed for the Builder tool
// ---------------------------------------------------------------------------

describe('parseProfileQualityConfig', () => {
  it('returns the parsed object on valid input', () => {
    const out = parseProfileQualityConfig({
      sycophancy: 'low',
      boundaries: { presets: ['no-medical-advice'] },
    });
    assert.equal(out.sycophancy, 'low');
  });

  it('throws on invalid input', () => {
    assert.throws(() => parseProfileQualityConfig({ sycophancy: 'extreme' }));
  });
});

// ---------------------------------------------------------------------------
// Capability metadata
// ---------------------------------------------------------------------------

describe('capability metadata', () => {
  it('exports the well-known service name', () => {
    assert.equal(RESPONSE_GUARD_SERVICE_NAME, 'responseGuard');
  });

  it('exports the well-known capability string', () => {
    assert.equal(RESPONSE_GUARD_CAPABILITY, 'responseGuard@1');
  });
});
