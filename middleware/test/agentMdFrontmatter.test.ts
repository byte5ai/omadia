import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseAgentMd } from '../src/plugins/agentMdFrontmatter.js';

/**
 * Phase 3 / OB-67 Slice 7 — agent.md frontmatter reader tests.
 *
 * Coverage:
 *   - No frontmatter → null + verbatim body
 *   - Valid quality + persona → both extracted, body intact
 *   - Only quality, only persona → independent extraction
 *   - Malformed YAML / closing missing → null frontmatter, body unchanged
 *   - Schema-drift in one block doesn't suppress the other
 *   - Empty frontmatter (`---\n---`) → empty object, body OK
 *   - Buffer input handled
 *   - Raw object preserved for downstream consumers (identity etc.)
 */

const SAMPLE_AGENT_MD = `---
schema_version: 1
identity:
  id: de.byte5.agent.test
  display_name: Test Agent
quality:
  sycophancy: medium
  boundaries:
    presets:
      - factual-only
persona:
  template: software-engineer
  axes:
    directness: 80
    warmth: 30
    sarcasm: 90
  custom_notes: Antworte auf Deutsch.
---

# Role

You are a test agent.
`;

describe('parseAgentMd', () => {
  it('no frontmatter → null + verbatim body', () => {
    const text = '# Just markdown\n\nNo frontmatter here.\n';
    const out = parseAgentMd(text);
    assert.equal(out.frontmatter, null);
    assert.equal(out.body, text);
  });

  it('extracts quality + persona + raw from a complete frontmatter', () => {
    const out = parseAgentMd(SAMPLE_AGENT_MD);
    assert.ok(out.frontmatter, 'frontmatter must parse');
    assert.equal(out.frontmatter!.quality?.sycophancy, 'medium');
    assert.deepEqual(out.frontmatter!.quality?.boundaries?.presets, [
      'factual-only',
    ]);
    assert.equal(out.frontmatter!.persona?.template, 'software-engineer');
    assert.equal(out.frontmatter!.persona?.axes?.directness, 80);
    assert.equal(out.frontmatter!.persona?.axes?.sarcasm, 90);
    assert.equal(
      out.frontmatter!.persona?.custom_notes,
      'Antworte auf Deutsch.',
    );
    assert.match(out.body, /^# Role/);
    // Raw object retains identity for downstream consumers
    const id = (
      out.frontmatter!.raw['identity'] as Record<string, unknown>
    )['id'];
    assert.equal(id, 'de.byte5.agent.test');
  });

  it('only quality block extracted when persona is absent', () => {
    const text = `---
quality:
  sycophancy: high
---

body
`;
    const out = parseAgentMd(text);
    assert.equal(out.frontmatter?.quality?.sycophancy, 'high');
    assert.equal(out.frontmatter?.persona, undefined);
  });

  it('only persona block extracted when quality is absent', () => {
    const text = `---
persona:
  axes:
    directness: 80
---

body
`;
    const out = parseAgentMd(text);
    assert.equal(out.frontmatter?.persona?.axes?.directness, 80);
    assert.equal(out.frontmatter?.quality, undefined);
  });

  it('schema-drift in persona does not suppress a valid quality block', () => {
    const text = `---
quality:
  sycophancy: medium
persona:
  axes:
    directness: "not a number"
---

body
`;
    const logs: string[] = [];
    const out = parseAgentMd(text, (m) => logs.push(m));
    assert.equal(out.frontmatter?.quality?.sycophancy, 'medium');
    assert.equal(out.frontmatter?.persona, undefined);
    assert.ok(logs.some((l) => /persona block invalid/i.test(l)));
  });

  it('returns null frontmatter when YAML is malformed', () => {
    const text = `---
quality: { sycophancy: medium
---

body
`;
    const logs: string[] = [];
    const out = parseAgentMd(text, (m) => logs.push(m));
    assert.equal(out.frontmatter, null);
    assert.match(out.body, /quality/); // body returned as-is
    assert.ok(logs.some((l) => /YAML parse/i.test(l)));
  });

  it('returns null frontmatter when closing --- is missing', () => {
    const text = `---
quality:
  sycophancy: low

# Body without closing
`;
    const out = parseAgentMd(text);
    assert.equal(out.frontmatter, null);
    assert.equal(out.body, text);
  });

  it('handles empty frontmatter (---\\n---) as no-overrides', () => {
    const text = `---
---

body content
`;
    const out = parseAgentMd(text);
    assert.ok(out.frontmatter, 'empty frontmatter still parses');
    assert.equal(out.frontmatter!.quality, undefined);
    assert.equal(out.frontmatter!.persona, undefined);
    assert.deepEqual(out.frontmatter!.raw, {});
    assert.match(out.body, /^body content/);
  });

  it('accepts Buffer input', () => {
    const out = parseAgentMd(Buffer.from(SAMPLE_AGENT_MD, 'utf8'));
    assert.equal(out.frontmatter?.persona?.template, 'software-engineer');
  });

  it('rejects array-root frontmatter as invalid', () => {
    const text = `---
- foo
- bar
---

body
`;
    const logs: string[] = [];
    const out = parseAgentMd(text, (m) => logs.push(m));
    assert.equal(out.frontmatter, null);
    assert.ok(logs.some((l) => /mapping at the root/i.test(l)));
  });

  it('handles CRLF line endings', () => {
    const text = '---\r\nquality:\r\n  sycophancy: low\r\n---\r\n\r\nbody\r\n';
    const out = parseAgentMd(text);
    assert.equal(out.frontmatter?.quality?.sycophancy, 'low');
    assert.match(out.body, /^body/);
  });
});
