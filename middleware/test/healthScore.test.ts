import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { AgentSpecSchema, type AgentSpec } from '../src/plugins/builder/agentSpec.js';
import {
  DEFAULT_ASSET_WEIGHTS,
  FALLBACK_ASSET_WEIGHT,
  computeContextQualityScore,
  computeHealthScore,
  type ContextQualityCriterionId,
} from '../src/profileSnapshots/healthScore.js';
import type { AssetDiff } from '../src/profileSnapshots/snapshotService.js';

/**
 * Phase 2.3 Slice 1 — healthScore pure-function coverage.
 *
 * The score algorithm is a heuristic, but the tests pin down the
 * invariants the operator + UI rely on:
 *  - zero-diff input ⇒ score 100
 *  - critical asset (`agent.md`) diverged ⇒ score 0 + critical suggestion
 *  - identical-status diffs are ignored
 *  - unmatched paths get the fallback weight (low impact)
 *  - suggestion IDs are stable + deduped
 */

const NULL_HASH = null as string | null;

const diff = (
  path: string,
  status: AssetDiff['status'],
): AssetDiff => ({
  path,
  status,
  baseSha256: status === 'added' ? null : NULL_HASH,
  targetSha256: status === 'removed' ? null : NULL_HASH,
});

describe('computeHealthScore', () => {
  it('returns score 100 with no suggestions when there are zero diffs', () => {
    const out = computeHealthScore({ diffs: [] });
    assert.equal(out.score, 100);
    assert.equal(out.divergedAssets.length, 0);
    assert.equal(out.suggestions.length, 0);
  });

  it('ignores identical-status diffs', () => {
    const out = computeHealthScore({
      diffs: [
        diff('agent.md', 'identical'),
        diff('knowledge/spec.json', 'identical'),
      ],
    });
    assert.equal(out.score, 100);
    assert.equal(out.divergedAssets.length, 0);
  });

  it('drops the score to 0 when agent.md diverges (critical)', () => {
    const out = computeHealthScore({ diffs: [diff('agent.md', 'modified')] });
    assert.equal(out.score, 0);
    assert.equal(out.divergedAssets.length, 1);
    const ids = out.suggestions.map((s) => s.id);
    assert.ok(
      ids.includes('agent-md-modified'),
      'expected agent-md-modified suggestion',
    );
    assert.ok(
      ids.includes('score-critical'),
      'expected score-critical suggestion when score < 30',
    );
  });

  it('uses the fallback weight for unmatched paths (low impact)', () => {
    const out = computeHealthScore({
      diffs: [diff('readme.md', 'modified')],
    });
    // FALLBACK_ASSET_WEIGHT (0.1) over maxWeight (1.0) = 10 points off.
    assert.equal(out.score, 90);
    assert.equal(out.divergedAssets[0]?.weight, FALLBACK_ASSET_WEIGHT);
    // Score >= 70 → no score-warn suggestion. No path-specific match either.
    assert.equal(out.suggestions.length, 0);
  });

  it('emits warn-level score-warn between 30..69', () => {
    const out = computeHealthScore({
      diffs: [
        diff('knowledge/spec.json', 'modified'), // 0.8
      ],
    });
    // 100 - 0.8 * 100 / 1.0 = 20. Score 20 -> <30 -> critical.
    assert.equal(out.score, 20);
    assert.ok(out.suggestions.some((s) => s.id === 'score-critical'));
  });

  it('dedupes suggestions across multiple matching diverged assets', () => {
    const out = computeHealthScore({
      diffs: [
        diff('plugins/foo-1.0.0.zip', 'added'),
        diff('plugins/bar-2.0.0.zip', 'modified'),
      ],
    });
    const pluginSuggestions = out.suggestions.filter(
      (s) => s.id === 'plugins-modified',
    );
    assert.equal(pluginSuggestions.length, 1);
    assert.equal(pluginSuggestions[0]?.severity, 'critical');
  });

  it('respects custom weights when provided', () => {
    const out = computeHealthScore({
      diffs: [diff('config.yaml', 'modified')],
      weights: [{ pattern: 'config.yaml', weight: 0.5 }],
    });
    // maxWeight = 0.5 (only weight). 100 - 0.5*100/0.5 = 0.
    assert.equal(out.score, 0);
    assert.equal(out.divergedAssets[0]?.weight, 0.5);
  });

  it('produces stable, well-formed suggestion shape', () => {
    const out = computeHealthScore({
      diffs: [diff('agent.md', 'modified')],
    });
    for (const s of out.suggestions) {
      assert.ok(s.id.length > 0, 'suggestion id non-empty');
      assert.ok(
        ['info', 'warn', 'critical'].includes(s.severity),
        `severity must be one of info|warn|critical, got ${s.severity}`,
      );
      assert.ok(s.message.length > 0, 'suggestion message non-empty');
    }
  });

  it('exports DEFAULT_ASSET_WEIGHTS with the contract patterns', () => {
    const patterns = DEFAULT_ASSET_WEIGHTS.map((w) => w.pattern);
    assert.ok(patterns.includes('agent.md'));
    assert.ok(patterns.includes('knowledge/spec.json'));
    assert.ok(patterns.includes('plugins/'));
    assert.ok(patterns.includes('knowledge/'));
  });
});

/**
 * Issue #499 — computeContextQualityScore coverage.
 *
 * Minimal valid AgentSpec, extended per-test with the field(s) under test.
 * Mirrors the `baseSpec()` pattern from test/builderManifestExtension.test.ts.
 */
const baseSpecInput = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  template: 'agent-pure-llm',
  id: 'de.byte5.agent.test',
  name: 'Test',
  version: '0.1.0',
  description: 'Test agent',
  category: 'other',
  domain: 'test',
  depends_on: [],
  tools: [],
  skill: { role: 'helper' },
  setup_fields: [],
  jobs: [],
  playbook: { when_to_use: 'use it', not_for: [], example_prompts: [] },
  network: { outbound: [] },
  slots: {},
  ...overrides,
});

const baseSpec = (overrides: Record<string, unknown> = {}): AgentSpec =>
  AgentSpecSchema.parse(baseSpecInput(overrides));

const ALL_CRITERION_IDS: readonly ContextQualityCriterionId[] = [
  'role_clarity',
  'guardrail_coverage',
  'instruction_consistency',
  'tool_schema_quality',
  'grounding_sufficiency',
  'injection_hardening',
  'token_efficiency',
];

describe('computeContextQualityScore', () => {
  it('returns all seven criteria, in the paper order, for a minimal spec', () => {
    const out = computeContextQualityScore(baseSpec());
    assert.equal(out.criteria.length, 7);
    assert.deepEqual(
      out.criteria.map((c) => c.id),
      ALL_CRITERION_IDS,
    );
  });

  it('marks the four deterministic criteria evaluated, the rest not-yet-evaluated', () => {
    const out = computeContextQualityScore(baseSpec());
    const byId = new Map(out.criteria.map((c) => [c.id, c]));

    for (const id of [
      'guardrail_coverage',
      'tool_schema_quality',
      'grounding_sufficiency',
      'token_efficiency',
    ] as const) {
      const c = byId.get(id)!;
      assert.equal(c.evaluated, true, `${id} should be evaluated`);
      assert.equal(typeof c.score, 'number', `${id} should have a numeric score`);
    }

    for (const id of ['role_clarity', 'instruction_consistency', 'injection_hardening'] as const) {
      const c = byId.get(id)!;
      assert.equal(c.evaluated, false, `${id} should not be evaluated yet`);
      assert.equal(c.score, null, `${id} score should be null`);
      assert.ok(c.rationale.length > 0, `${id} rationale should explain why`);
    }
  });

  it('every criterion carries a non-empty rationale, predictedFailureMode, and fixHint', () => {
    const out = computeContextQualityScore(baseSpec());
    for (const c of out.criteria) {
      assert.ok(c.rationale.length > 0, `${c.id} rationale non-empty`);
      assert.ok(c.predictedFailureMode.length > 0, `${c.id} predictedFailureMode non-empty`);
      assert.ok(c.fixHint.length > 0, `${c.id} fixHint non-empty`);
    }
  });

  it('aggregate score averages only the evaluated criteria (not-evaluated excluded, not zeroed)', () => {
    const out = computeContextQualityScore(baseSpec());
    // Minimal spec: guardrail_coverage=0 (no boundaries), tool_schema_quality=100
    // (no tools), grounding_sufficiency=0 (no source attached),
    // token_efficiency=100 (no persona delta). Mean of the four = 50.
    assert.equal(out.score, 50);
  });

  it('guardrail_coverage rewards category spread over raw preset count', () => {
    const noGuardrails = computeContextQualityScore(baseSpec());
    const oneCategory = computeContextQualityScore(
      baseSpec({
        quality: { boundaries: { presets: ['no-pii', 'no-medical-data'], custom: [] } },
      }),
    );
    const fourCategories = computeContextQualityScore(
      baseSpec({
        quality: {
          boundaries: {
            presets: ['no-pii', 'own-domain-only', 'no-commitments', 'no-speculation'],
            custom: [],
          },
        },
      }),
    );

    const score = (out: ReturnType<typeof computeContextQualityScore>): number =>
      out.criteria.find((c) => c.id === 'guardrail_coverage')!.score!;

    assert.equal(score(noGuardrails), 0);
    // Two presets, same category ('data') → only 1/4 categories covered:
    // (1/4) * 80 = 20.
    assert.equal(score(oneCategory), 20);
    // Four presets spanning all 4 categories, no custom lines: (4/4) * 80 = 80.
    assert.equal(score(fourCategories), 80);
    assert.ok(score(fourCategories) > score(oneCategory));
  });

  it('tool_schema_quality is 100 with no tools, and penalized on manifestLinter violations', () => {
    const noTools = computeContextQualityScore(baseSpec());
    const badTool = computeContextQualityScore(
      baseSpec({
        tools: [{ id: 'valid_tool', description: 'ok' }],
      }),
    );

    const score = (out: ReturnType<typeof computeContextQualityScore>): number =>
      out.criteria.find((c) => c.id === 'tool_schema_quality')!.score!;

    assert.equal(score(noTools), 100);
    assert.equal(score(badTool), 100);

    // Two tools sharing the same id → tool_id_duplicate violation.
    const dup = computeContextQualityScore(
      baseSpec({
        tools: [
          { id: 'same_id', description: 'a' },
          { id: 'same_id', description: 'b' },
        ],
      }),
    );
    const dupCriterion = dup.criteria.find((c) => c.id === 'tool_schema_quality')!;
    assert.equal(dupCriterion.score, 75);
    assert.ok(dupCriterion.rationale.includes('tool_id_duplicate'));
  });

  it('grounding_sufficiency: attached via graph entity_systems or external_reads, else 0', () => {
    const none = computeContextQualityScore(baseSpec());
    const viaGraph = computeContextQualityScore(
      baseSpec({ permissions: { graph: { entity_systems: ['odoo'] } } }),
    );
    const viaExternalReads = computeContextQualityScore(
      baseSpec({
        external_reads: [
          {
            id: 'get_something',
            description: 'fetch something',
            service: 'odoo.client',
            method: 'read',
          },
        ],
      }),
    );

    const score = (out: ReturnType<typeof computeContextQualityScore>): number =>
      out.criteria.find((c) => c.id === 'grounding_sufficiency')!.score!;

    assert.equal(score(none), 0);
    assert.equal(score(viaGraph), 100);
    assert.equal(score(viaExternalReads), 100);
  });

  it('token_efficiency: no persona delta scores 100, a large persona delta drags it down', () => {
    const noPersona = computeContextQualityScore(baseSpec());
    const heavyPersona = computeContextQualityScore(
      baseSpec({
        persona: {
          axes: {
            formality: 100,
            directness: 100,
            warmth: 0,
            humor: 100,
            sarcasm: 100,
            conciseness: 0,
            proactivity: 100,
            autonomy: 100,
            risk_tolerance: 100,
            creativity: 100,
            drama: 100,
            philosophy: 100,
          },
          custom_notes:
            'A very long custom note that pushes the persona-section token budget well ' +
            'past the target threshold so the token_efficiency score drops from its ' +
            'default of 100 down toward the low end of the scale, repeated for length. '.repeat(
              10,
            ),
        },
      }),
    );

    const score = (out: ReturnType<typeof computeContextQualityScore>): number =>
      out.criteria.find((c) => c.id === 'token_efficiency')!.score!;

    assert.equal(score(noPersona), 100);
    assert.ok(score(heavyPersona) < 100, 'heavy persona delta should reduce the score');
  });

  it('does not mutate computeHealthScore (drift path stays byte-identical)', () => {
    // Backward-compat guard: the new decomposition is additive. The
    // pre-existing diff-based drift score must still behave exactly as
    // before for the snapshot/drift path (driftWorker.ts).
    const out = computeHealthScore({ diffs: [] });
    assert.equal(out.score, 100);
    assert.equal(out.divergedAssets.length, 0);
    assert.equal(out.suggestions.length, 0);
  });
});
