import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  composeBoundariesFromAgentMd,
  composePersonaFromAgentMd,
  composeSycophancyFromAgentMd,
} from '../../src/plugins/dynamicAgentRuntime.js';
import { compileBoundariesSection } from '../../src/plugins/builder/boundaryPresets.js';
import { composePersonaSection } from '../../src/plugins/personaCompose.js';
import { compileSycophancyGuard } from '../../src/plugins/sycophancyGuard.js';

/**
 * Issue #55 follow-up — byte-identical guarantee between the runtime
 * compose path (reads AGENT.md → parse → call inner helpers) and the
 * preview-prompt route (calls the same inner helpers directly with the
 * draft spec).
 *
 * Both paths share the inner helpers `composePersonaSection`,
 * `compileBoundariesSection`, `compileSycophancyGuard`. This test
 * makes the equivalence explicit: serialise a fixture spec to an
 * AGENT.md, run the AGENT.md-backed outer helpers, run the spec-backed
 * inner helpers, assert byte-equality.
 */

const FIXTURES = [
  {
    name: 'persona-only',
    persona: { axes: { directness: 80, warmth: 30 }, custom_notes: 'Antworte auf Deutsch.' },
    quality: undefined as unknown as { sycophancy?: string; boundaries?: { presets?: string[]; custom?: string[] } } | undefined,
  },
  {
    name: 'boundaries+sycophancy',
    persona: undefined as unknown as { axes?: Record<string, number>; custom_notes?: string } | undefined,
    quality: {
      sycophancy: 'medium' as const,
      boundaries: { presets: ['no-pii', 'no-medical-data'], custom: ['no Spekulationen'] },
    },
  },
  {
    name: 'fully-configured',
    persona: {
      template: 'customer-service',
      axes: { directness: 80, warmth: 70, formality: 60 },
      custom_notes: 'Antworte auf Deutsch.',
    },
    quality: {
      sycophancy: 'high' as const,
      boundaries: { presets: ['no-pii'], custom: ['no PII'] },
    },
  },
];

function yamlize(obj: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (obj === null || obj === undefined) return '~';
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (typeof obj === 'number') return String(obj);
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return '\n' + obj.map((v) => `${pad}- ${yamlize(v, indent + 1).trim()}`).join('\n');
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    return '\n' + entries.map(([k, v]) => `${pad}${k}: ${yamlize(v, indent + 1)}`).join('\n');
  }
  return '';
}

describe('preview-prompt parity vs runtime (issue #55 follow-up)', () => {
  let pkgRoot: string;

  beforeEach(async () => {
    pkgRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-parity-'));
  });

  afterEach(() => {
    rmSync(pkgRoot, { recursive: true, force: true });
  });

  for (const fixture of FIXTURES) {
    it(`fixture ${fixture.name}: AGENT.md-backed runtime output is byte-identical to spec-backed inner output`, async () => {
      const frontmatter: Record<string, unknown> = {};
      if (fixture.persona) frontmatter['persona'] = fixture.persona;
      if (fixture.quality) frontmatter['quality'] = fixture.quality;
      const yaml = yamlize(frontmatter).replace(/^\n/, '');
      const agentMd = `---\n${yaml}\n---\n\n# Body\n`;
      await fs.writeFile(path.join(pkgRoot, 'AGENT.md'), agentMd);

      // Outer (runtime) path — reads AGENT.md, parses frontmatter, calls inner.
      const runtimePersona = await composePersonaFromAgentMd(pkgRoot, 'claude-sonnet-4-6');
      const runtimeBoundaries = await composeBoundariesFromAgentMd(pkgRoot);
      const runtimeSycophancy = await composeSycophancyFromAgentMd(pkgRoot);

      // Inner (preview-route) path — calls the inner helpers directly with the spec.
      const previewPersona = fixture.persona
        ? composePersonaSection({ persona: fixture.persona, family: 'sonnet' })
        : '';
      const previewBoundaries = fixture.quality?.boundaries
        ? compileBoundariesSection(
            fixture.quality.boundaries.presets ?? [],
            fixture.quality.boundaries.custom ?? [],
          ).text
        : '';
      const previewSycophancy = compileSycophancyGuard(
        fixture.quality?.sycophancy as 'off' | 'low' | 'medium' | 'high' | undefined,
      );

      assert.equal(runtimePersona, previewPersona, 'persona section diverged');
      assert.equal(runtimeBoundaries, previewBoundaries, 'boundaries section diverged');
      assert.equal(runtimeSycophancy, previewSycophancy, 'sycophancy section diverged');
    });
  }
});
