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
 * spurious key reorderings.
 *
 * Spec 2042 §5.10 — a Plugin Builder draft is a capability plugin: the
 * document carries identity, kind and playbook, never a persona, quality
 * settings or role text — also not for a draft stored before the change.
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
        description: 'A useful plugin',
        category: 'productivity',
        version: '0.2.0',
      }),
    });
    const fm = extractFrontmatter(buf.toString('utf8'));
    assert.equal(fm.identity.id, 'spec-id');
    assert.equal(fm.identity.display_name, 'Spec Name');
    assert.equal(fm.identity.description, 'A useful plugin');
    assert.equal(fm.identity.category, 'productivity');
    assert.equal(fm.identity.version, '0.2.0');
  });

  it('carries the effective plugin kind', () => {
    const tool = extractFrontmatter(
      specToAgentMd({ draftId: 'd', draftName: 'D', spec: makeSpec() }).toString('utf8'),
    );
    assert.equal(tool.identity.kind, 'tool');
    const integration = extractFrontmatter(
      specToAgentMd({
        draftId: 'd',
        draftName: 'D',
        spec: makeSpec({ depends_on: ['@omadia/integration-odoo'] }),
      }).toString('utf8'),
    );
    assert.equal(integration.identity.kind, 'integration');
  });

  it('never emits persona, quality or role text, even from an old draft', () => {
    const legacy = {
      ...makeSpec({ id: 'demo', name: 'Demo' }),
      skill: { role: 'Du bist ein Stratege.', tonality: 'scharf' },
      persona: { template: 'strategist', custom_notes: 'sei frech' },
      quality: { sycophancy: 'high' },
    };
    const text = specToAgentMd({ draftId: 'demo', draftName: 'Demo', spec: legacy }).toString('utf8');
    const fm = extractFrontmatter(text) as Record<string, unknown>;
    assert.equal(fm['persona'], undefined);
    assert.equal(fm['quality'], undefined);
    assert.doesNotMatch(text, /Stratege|scharf|frech|# Role|Tonality/);
  });
});

describe('specToAgentMd · body', () => {
  it('renders description + playbook sections in stable order', () => {
    const buf = specToAgentMd({
      draftId: 'd',
      draftName: 'D',
      spec: makeSpec({
        name: 'Editor',
        description: 'Checks prose for clarity.',
        playbook: {
          when_to_use: 'Editing prose for clarity',
          not_for: ['code review'],
          example_prompts: ['rewrite this paragraph for clarity'],
        },
      }),
    });
    const text = buf.toString('utf8');
    const body = text.split('---\n').slice(2).join('---\n');
    const descIdx = body.indexOf('# Editor');
    const whenIdx = body.indexOf('## When to use');
    const notIdx = body.indexOf('## Not for');
    const exIdx = body.indexOf('## Example prompts');
    assert.ok(descIdx >= 0, 'description section must render');
    assert.ok(whenIdx > descIdx, 'When-to-use after description');
    assert.ok(notIdx > whenIdx, 'Not-for after When-to-use');
    assert.ok(exIdx > notIdx, 'Examples after Not-for');
  });

  it('falls back to a placeholder body when no narrative fields are set', () => {
    const buf = specToAgentMd({
      draftId: 'd',
      draftName: 'D',
      spec: makeSpec({ playbook: { when_to_use: '', not_for: [], example_prompts: [] } }),
    });
    const text = buf.toString('utf8');
    assert.ok(text.includes('plugin description not yet authored'));
  });
});

describe('specToAgentMd · determinism', () => {
  it('two calls with identical input produce byte-identical output', () => {
    const spec = makeSpec({
      id: 'demo',
      name: 'Demo',
      description: 'short',
      playbook: { when_to_use: 'now', not_for: ['x'], example_prompts: ['y'] },
    });
    const a = specToAgentMd({ draftId: 'demo', draftName: 'Demo', spec });
    const b = specToAgentMd({ draftId: 'demo', draftName: 'Demo', spec });
    assert.equal(a.toString('utf8'), b.toString('utf8'));
  });

  it('uses LF line endings (no CRLF)', () => {
    const buf = specToAgentMd({
      draftId: 'd',
      draftName: 'D',
      spec: makeSpec({ description: 'a' }),
    });
    assert.equal(buf.includes('\r\n'), false);
  });
});

// helpers ─────────────────────────────────────────────────────────────────

function extractFrontmatter(text: string): {
  schema_version: number;
  identity: {
    id: string;
    display_name: string;
    description?: string;
    category?: string;
    version?: string;
    kind?: string;
  };
} {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, 'frontmatter not found');
  const yamlText = match[1]!;
  return parseYaml(yamlText) as never;
}
