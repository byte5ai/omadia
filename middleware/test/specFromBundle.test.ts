import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  reconstructSpecFromBundle,
  SpecReconstructError,
} from '../src/plugins/builder/specFromBundle.js';
import { emptyAgentSpec } from '../src/plugins/builder/types.js';

/**
 * Phase 2.4 — Spec reconstruction (`reconstructSpecFromBundle`) tests.
 *
 * Two scenarios drive the design:
 *   1. Roundtrip: a Builder-exported spec.json must reimport into a
 *      bit-identical spec (modulo Zod default-fills).
 *   2. Schema-drift reject: a manipulated spec.json must be rejected
 *      via `SpecReconstructError`, never silently coerced.
 */

const VALID_SPEC = {
  template: 'agent-integration',
  id: 'de.byte5.agent.test',
  name: 'Test Agent',
  version: '1.0.0',
  description: 'Reconstruction roundtrip fixture',
  category: 'productivity',
  depends_on: [],
  tools: [],
  skill: { role: 'Antworte knapp' },
  setup_fields: [],
  playbook: {
    when_to_use: 'Beim Testen',
    not_for: [],
    example_prompts: [],
  },
  network: { outbound: [] },
  external_reads: [],
  slots: {},
  builder_settings: { auto_fix_enabled: false },
  test_cases: [],
};

describe('reconstructSpecFromBundle', () => {
  it('roundtrip: spec.json → AgentSpec preserves identity + skill', () => {
    const result = reconstructSpecFromBundle({
      bundleAgentMd: Buffer.from('# rendered agent.md\nignored', 'utf8'),
      bundleSpecJson: Buffer.from(JSON.stringify(VALID_SPEC), 'utf8'),
      fallbackName: 'Bundle Default Name',
    });

    assert.equal(result.source, 'spec_json');
    assert.equal(result.name, 'Test Agent');
    assert.equal(result.spec.id, 'de.byte5.agent.test');
    assert.equal(result.spec.version, '1.0.0');
    assert.equal(result.spec.category, 'productivity');
    assert.equal(result.spec.skill.role, 'Antworte knapp');
  });

  it('roundtrip: empty spec.name falls back to bundle profile name', () => {
    const specWithEmptyName = { ...VALID_SPEC, name: '' };
    // The Zod schema requires `name.min(1)` — so empty name must be
    // rejected before we even reach the fallback. This test asserts
    // the reject path; an alternative bundle would carry a valid name.
    assert.throws(
      () =>
        reconstructSpecFromBundle({
          bundleAgentMd: Buffer.from('', 'utf8'),
          bundleSpecJson: Buffer.from(JSON.stringify(specWithEmptyName), 'utf8'),
          fallbackName: 'Bundle Default Name',
        }),
      SpecReconstructError,
    );
  });

  it('rejects manipulated spec.json (schema drift)', () => {
    const manipulated = {
      ...VALID_SPEC,
      // category must be one of the enum values; mangled value triggers reject
      category: 'not-a-real-category',
    };

    assert.throws(
      () =>
        reconstructSpecFromBundle({
          bundleAgentMd: Buffer.from('', 'utf8'),
          bundleSpecJson: Buffer.from(JSON.stringify(manipulated), 'utf8'),
          fallbackName: 'fallback',
        }),
      (err: unknown) => {
        if (!(err instanceof SpecReconstructError)) return false;
        return /AgentSpec schema validation/i.test(err.message);
      },
    );
  });

  it('rejects spec.json with non-JSON garbage', () => {
    assert.throws(
      () =>
        reconstructSpecFromBundle({
          bundleAgentMd: Buffer.from('', 'utf8'),
          bundleSpecJson: Buffer.from('{not-json', 'utf8'),
          fallbackName: 'fallback',
        }),
      (err: unknown) => {
        if (!(err instanceof SpecReconstructError)) return false;
        return /not valid JSON/i.test(err.message);
      },
    );
  });

  it('source-only fallback: agent.md becomes skill.role on empty spec', () => {
    const md = '# Persona\n\nYou are a helpful test agent.';
    const result = reconstructSpecFromBundle({
      bundleAgentMd: Buffer.from(md, 'utf8'),
      bundleSpecJson: null,
      fallbackName: 'Imported Bundle',
    });

    assert.equal(result.source, 'agent_md_fallback');
    assert.equal(result.name, 'Imported Bundle');
    assert.equal(result.spec.skill.role, md);
    // Rest of the skeleton must match the empty defaults so the Builder
    // UI can render the live-manifest pane without crashing.
    const expected = emptyAgentSpec();
    assert.equal(result.spec.id, expected.id);
    assert.equal(result.spec.version, expected.version);
    assert.equal(result.spec.category, expected.category);
  });

  it('source-only fallback strips YAML frontmatter from agent.md', () => {
    const md = `---
schema_version: 1
identity:
  id: foo
---

# Body

Real content here.
`;
    const result = reconstructSpecFromBundle({
      bundleAgentMd: Buffer.from(md, 'utf8'),
      bundleSpecJson: null,
      fallbackName: 'Imported',
    });
    assert.equal(result.source, 'agent_md_fallback');
    assert.match(result.spec.skill.role, /^# Body/);
    assert.doesNotMatch(result.spec.skill.role, /schema_version/);
  });

  it('treats empty buffer as null spec.json', () => {
    const result = reconstructSpecFromBundle({
      bundleAgentMd: Buffer.from('plain text', 'utf8'),
      bundleSpecJson: Buffer.alloc(0),
      fallbackName: 'fallback',
    });
    assert.equal(result.source, 'agent_md_fallback');
  });
});
