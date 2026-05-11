import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parse as parseYaml } from 'yaml';

import { specToAgentMd } from '../src/plugins/builder/specToAgentMd.js';
import { emptyAgentSpec } from '../src/plugins/builder/types.js';

/**
 * Slice 1 of OB-83 — spec → agent.md serialiser.
 *
 * The bridge mirrors every draft save into `profile_agent_md`; the bytes
 * have to be deterministic so Snapshot bundle_hash isn't churned by
 * spurious key reorderings. Frontmatter schema-syncs with persona-ui-v1.md
 * §6 (identity + quality blocks).
 */

function makeSpec(overrides: Partial<ReturnType<typeof emptyAgentSpec>> = {}) {
  return { ...emptyAgentSpec(), ...overrides };
}

describe('specToAgentMd · frontmatter', () => {
  it('renders identity from draft fallback when spec id/name are empty', () => {
    const buf = specToAgentMd({
      draftId: 'demo-bot',
      draftName: 'Demo Bot',
      spec: makeSpec({ id: '', name: '' }),
    });
    const text = buf.toString('utf8');
    assert.ok(text.startsWith('---\n'));
    const fm = extractFrontmatter(text);
    assert.equal(fm.schema_version, 1);
    assert.equal(fm.identity.id, 'demo-bot');
    assert.equal(fm.identity.display_name, 'Demo Bot');
  });

  it('prefers spec.id + spec.name when set', () => {
    const buf = specToAgentMd({
      draftId: 'fallback-id',
      draftName: 'Fallback Name',
      spec: makeSpec({
        id: 'spec-id',
        name: 'Spec Name',
        description: 'A useful agent',
        category: 'productivity',
        version: '0.2.0',
      }),
    });
    const fm = extractFrontmatter(buf.toString('utf8'));
    assert.equal(fm.identity.id, 'spec-id');
    assert.equal(fm.identity.display_name, 'Spec Name');
    assert.equal(fm.identity.description, 'A useful agent');
    assert.equal(fm.identity.category, 'productivity');
    assert.equal(fm.identity.version, '0.2.0');
  });

  it('omits quality block when spec has no real quality content', () => {
    const buf = specToAgentMd({
      draftId: 'd',
      draftName: 'D',
      spec: makeSpec(),
    });
    const fm = extractFrontmatter(buf.toString('utf8'));
    assert.equal(fm.quality, undefined);
  });

  it('omits quality block when sycophancy is "off" with empty boundaries', () => {
    const buf = specToAgentMd({
      draftId: 'd',
      draftName: 'D',
      spec: makeSpec({
        quality: { sycophancy: 'off', boundaries: { presets: [], custom: [] } },
      }),
    });
    const fm = extractFrontmatter(buf.toString('utf8'));
    assert.equal(fm.quality, undefined);
  });

  it('serialises quality block when sycophancy is non-off', () => {
    const buf = specToAgentMd({
      draftId: 'd',
      draftName: 'D',
      spec: makeSpec({
        quality: { sycophancy: 'high', boundaries: { presets: ['factual-only'], custom: [] } },
      }),
    });
    const fm = extractFrontmatter(buf.toString('utf8'));
    assert.deepEqual(fm.quality, {
      sycophancy: 'high',
      boundaries: { presets: ['factual-only'], custom: [] },
    });
  });

  it('serialises quality block when only custom rules are set', () => {
    const buf = specToAgentMd({
      draftId: 'd',
      draftName: 'D',
      spec: makeSpec({
        quality: { boundaries: { presets: [], custom: ['no-medical-advice'] } },
      }),
    });
    const fm = extractFrontmatter(buf.toString('utf8'));
    assert.equal(fm.quality?.boundaries?.custom?.[0], 'no-medical-advice');
  });
});

describe('specToAgentMd · body', () => {
  it('renders skill.role + tonality + playbook sections in stable order', () => {
    const buf = specToAgentMd({
      draftId: 'd',
      draftName: 'D',
      spec: makeSpec({
        skill: { role: 'You are a careful editor.', tonality: 'precise, friendly' },
        playbook: {
          when_to_use: 'Editing prose for clarity',
          not_for: ['code review'],
          example_prompts: ['rewrite this paragraph for clarity'],
        },
      }),
    });
    const text = buf.toString('utf8');
    const body = text.split('---\n').slice(2).join('---\n');
    const roleIdx = body.indexOf('# Role');
    const tonIdx = body.indexOf('## Tonality');
    const whenIdx = body.indexOf('## When to use');
    const notIdx = body.indexOf('## Not for');
    const exIdx = body.indexOf('## Example prompts');
    assert.ok(roleIdx >= 0, 'Role section must render');
    assert.ok(tonIdx > roleIdx, 'Tonality after Role');
    assert.ok(whenIdx > tonIdx, 'When-to-use after Tonality');
    assert.ok(notIdx > whenIdx, 'Not-for after When-to-use');
    assert.ok(exIdx > notIdx, 'Examples after Not-for');
  });

  it('falls back to a placeholder body when no narrative fields are set', () => {
    const buf = specToAgentMd({
      draftId: 'd',
      draftName: 'D',
      spec: makeSpec({ skill: { role: '' }, playbook: { when_to_use: '', not_for: [], example_prompts: [] } }),
    });
    const text = buf.toString('utf8');
    assert.ok(text.includes('agent body not yet authored'));
  });
});

describe('specToAgentMd · persona block (Phase 3 / OB-67)', () => {
  it('omits persona block when spec has no persona field', () => {
    const buf = specToAgentMd({
      draftId: 'd',
      draftName: 'D',
      spec: makeSpec({ skill: { role: 'something' } }),
    });
    const fm = extractFrontmatter(buf.toString('utf8'));
    assert.equal(fm.persona, undefined);
  });

  it('omits persona block when all axes are empty / template + notes blank', () => {
    const buf = specToAgentMd({
      draftId: 'd',
      draftName: 'D',
      spec: makeSpec({
        skill: { role: 'something' },
        persona: { axes: {}, template: '', custom_notes: '   ' },
      }),
    });
    const fm = extractFrontmatter(buf.toString('utf8'));
    assert.equal(fm.persona, undefined);
  });

  it('emits persona.axes when at least one axis is set', () => {
    const buf = specToAgentMd({
      draftId: 'd',
      draftName: 'D',
      spec: makeSpec({
        skill: { role: 'something' },
        persona: {
          axes: { directness: 80, warmth: 30 },
        },
      }),
    });
    const fm = extractFrontmatter(buf.toString('utf8'));
    assert.deepEqual(fm.persona, { axes: { directness: 80, warmth: 30 } });
  });

  it('emits template + custom_notes (trimmed) when set', () => {
    const buf = specToAgentMd({
      draftId: 'd',
      draftName: 'D',
      spec: makeSpec({
        skill: { role: 'something' },
        persona: {
          template: 'software-engineer',
          custom_notes: '  Antworte auf Deutsch.  ',
        },
      }),
    });
    const fm = extractFrontmatter(buf.toString('utf8'));
    assert.equal(fm.persona?.template, 'software-engineer');
    assert.equal(fm.persona?.custom_notes, 'Antworte auf Deutsch.');
  });

  it('determinism: same persona input → byte-identical output', () => {
    const spec = makeSpec({
      id: 'demo',
      name: 'Demo',
      description: 'short',
      skill: { role: 'do things' },
      playbook: { when_to_use: 'now', not_for: [], example_prompts: [] },
      persona: {
        template: 'software-engineer',
        axes: { directness: 80, warmth: 30, formality: 40 },
        custom_notes: 'metrische Einheiten',
      },
    });
    const a = specToAgentMd({ draftId: 'demo', draftName: 'Demo', spec });
    const b = specToAgentMd({ draftId: 'demo', draftName: 'Demo', spec });
    assert.equal(a.toString('utf8'), b.toString('utf8'));
  });
});

describe('specToAgentMd · determinism', () => {
  it('two calls with identical input produce byte-identical output', () => {
    const spec = makeSpec({
      id: 'demo',
      name: 'Demo',
      description: 'short',
      skill: { role: 'do things' },
      playbook: { when_to_use: 'now', not_for: ['x'], example_prompts: ['y'] },
      quality: { sycophancy: 'low' },
    });
    const a = specToAgentMd({ draftId: 'demo', draftName: 'Demo', spec });
    const b = specToAgentMd({ draftId: 'demo', draftName: 'Demo', spec });
    assert.equal(a.toString('utf8'), b.toString('utf8'));
  });

  it('uses LF line endings (no CRLF)', () => {
    const buf = specToAgentMd({
      draftId: 'd',
      draftName: 'D',
      spec: makeSpec({ skill: { role: 'a' } }),
    });
    assert.equal(buf.includes('\r\n'), false);
  });
});

// helpers ─────────────────────────────────────────────────────────────────

function extractFrontmatter(text: string): {
  schema_version: number;
  identity: { id: string; display_name: string; description?: string; category?: string; version?: string };
  quality?: { sycophancy?: string; boundaries?: { presets?: string[]; custom?: string[] } };
  persona?: {
    template?: string;
    axes?: Record<string, number>;
    custom_notes?: string;
  };
} {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, 'frontmatter not found');
  const yamlText = match[1]!;
  return parseYaml(yamlText) as never;
}
