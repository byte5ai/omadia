import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  composePersonaFromAgentMd,
  inferFamilyFromModel,
} from '../src/plugins/dynamicAgentRuntime.js';

/**
 * Phase 3 / OB-67 Slice 11 — runtime persona-section assembly tests.
 *
 * Verifies that an installed plugin's AGENT.md frontmatter (written by
 * the Builder codegen in Slice 10) reaches loadSystemPrompt and that
 * the composed `<persona>` section reflects the operator's slider
 * settings against the right model-family defaults.
 */
describe('inferFamilyFromModel', () => {
  it('classifies Anthropic model ids by family', () => {
    assert.equal(inferFamilyFromModel('claude-haiku-4-5'), 'haiku');
    assert.equal(inferFamilyFromModel('claude-sonnet-4-6'), 'sonnet');
    assert.equal(inferFamilyFromModel('claude-opus-4-7'), 'opus');
    assert.equal(inferFamilyFromModel('claude-opus-4-7[1m]'), 'opus');
  });

  it('case-insensitive matching', () => {
    assert.equal(inferFamilyFromModel('Claude-HAIKU-4-5'), 'haiku');
  });

  it('falls back to sonnet for unknown ids', () => {
    assert.equal(inferFamilyFromModel('gpt-4o'), 'sonnet');
    assert.equal(inferFamilyFromModel(''), 'sonnet');
  });
});

describe('composePersonaFromAgentMd', () => {
  let pkgRoot: string;

  beforeEach(async () => {
    pkgRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-rt-'));
  });

  afterEach(async () => {
    await fs.rm(pkgRoot, { recursive: true, force: true });
  });

  it('returns empty string when AGENT.md is missing', async () => {
    const out = await composePersonaFromAgentMd(pkgRoot, 'claude-sonnet-4-6');
    assert.equal(out, '');
  });

  it('returns empty string when AGENT.md has no persona block', async () => {
    await fs.writeFile(
      path.join(pkgRoot, 'AGENT.md'),
      `---
identity:
  id: foo
---

# Body
`,
    );
    const out = await composePersonaFromAgentMd(pkgRoot, 'claude-sonnet-4-6');
    assert.equal(out, '');
  });

  it('emits <persona> section when frontmatter has significant deltas', async () => {
    await fs.writeFile(
      path.join(pkgRoot, 'AGENT.md'),
      `---
persona:
  axes:
    sarcasm: 90
    directness: 80
  custom_notes: Antworte auf Deutsch.
---

# Body
`,
    );
    const out = await composePersonaFromAgentMd(pkgRoot, 'claude-sonnet-4-6');
    assert.match(out, /^<persona>/);
    assert.match(out, /sarcasm:.*ironic|sarcasm:.*biting|sarcasm:.*wry/i);
    assert.match(out, /directness:.*direct/i);
    assert.match(out, /Antworte auf Deutsch/);
    assert.match(out, /<\/persona>$/);
  });

  it('falls back to lowercase agent.md when AGENT.md is absent', async () => {
    await fs.writeFile(
      path.join(pkgRoot, 'agent.md'),
      `---
persona:
  axes:
    directness: 85
---

# Body
`,
    );
    const out = await composePersonaFromAgentMd(pkgRoot, 'claude-sonnet-4-6');
    assert.match(out, /<persona>/);
    assert.match(out, /directness:/);
  });

  it('uses model-family-aware deltas (Haiku vs Sonnet differ for same value)', async () => {
    await fs.writeFile(
      path.join(pkgRoot, 'AGENT.md'),
      `---
persona:
  axes:
    conciseness: 30
---

# Body
`,
    );
    const sonnetOut = await composePersonaFromAgentMd(
      pkgRoot,
      'claude-sonnet-4-6',
    );
    const haikuOut = await composePersonaFromAgentMd(
      pkgRoot,
      'claude-haiku-4-5',
    );
    // Sonnet base 45 → 30 = -15 (neutral, no emission)
    // Haiku base 65 → 30 = -35 (strong, emits)
    assert.equal(sonnetOut, '');
    assert.match(haikuOut, /conciseness:/);
  });

  it('all-neutral persona returns empty (cache-stable)', async () => {
    await fs.writeFile(
      path.join(pkgRoot, 'AGENT.md'),
      `---
persona:
  axes:
    directness: 55
---

# Body
`,
    );
    // Sonnet base 55, value 55 → delta 0 → neutral → empty
    const out = await composePersonaFromAgentMd(pkgRoot, 'claude-sonnet-4-6');
    assert.equal(out, '');
  });

  it('malformed frontmatter does not throw — returns empty', async () => {
    await fs.writeFile(
      path.join(pkgRoot, 'AGENT.md'),
      `---
persona:
  axes:
    directness: "not a number"
---

# Body
`,
    );
    const out = await composePersonaFromAgentMd(pkgRoot, 'claude-sonnet-4-6');
    assert.equal(out, '');
  });
});
