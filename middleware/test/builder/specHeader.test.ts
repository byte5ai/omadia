import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { buildSpecHeader } from '../../src/plugins/builder/builderAgent.js';
import type { SlotDef } from '../../src/plugins/builder/boilerplateSource.js';
import { emptyAgentSpec } from '../../src/plugins/builder/types.js';

const sampleSpec = (overrides: Partial<ReturnType<typeof emptyAgentSpec>> = {}): ReturnType<typeof emptyAgentSpec> => ({
  ...emptyAgentSpec(),
  template: 'agent-integration',
  id: 'de.byte5.agent.example',
  name: 'Example',
  description: 'desc',
  category: 'analysis',
  ...overrides,
});

const SLOT_MANIFEST: ReadonlyArray<SlotDef> = [
  {
    key: 'client-impl',
    target_file: 'src/client.ts',
    required: true,
    description: 'HTTP client class body',
  },
  {
    key: 'toolkit-impl',
    target_file: 'src/toolkit.ts',
    required: true,
  },
  {
    key: 'activate-body',
    target_file: 'src/plugin.ts',
    required: false,
  },
];

describe('buildSpecHeader (Step #1)', () => {
  it('renders the JSON spec block as before when no slot manifest is given', () => {
    const out = buildSpecHeader(sampleSpec());
    assert.match(out, /# Aktueller Draft-Stand/);
    assert.match(out, /```json/);
    // Without manifest there must be no "Template-Slots" checklist.
    assert.ok(!out.includes('Template-Slots'));
  });

  it('emits the slot checklist when a manifest is provided', () => {
    const out = buildSpecHeader(sampleSpec(), SLOT_MANIFEST);
    assert.match(out, /## Template-Slots — Checkliste/);
    assert.match(out, /Template \*\*`agent-integration`\*\*/);
    assert.match(out, /`client-impl` → `src\/client\.ts`/);
    assert.match(out, /`toolkit-impl` → `src\/toolkit\.ts`/);
    assert.match(out, /`activate-body` → `src\/plugin\.ts`/);
    // Required vs optional formatting.
    assert.match(out, /`client-impl`.+\(\*\*required\*\*\)/);
    assert.match(out, /`activate-body`.+\(optional\)/);
    // Description from the manifest is appended.
    assert.match(out, /HTTP client class body/);
  });

  it('marks empty draft slots as missing', () => {
    const out = buildSpecHeader(sampleSpec({ slots: {} }), SLOT_MANIFEST);
    assert.match(out, /`client-impl`.*✗ missing/);
    assert.match(out, /`toolkit-impl`.*✗ missing/);
    assert.match(out, /\*\*Missing required:\*\* `client-impl`, `toolkit-impl`\./);
  });

  it('marks filled slots as ✓ filled and only lists actually-missing required ones', () => {
    const out = buildSpecHeader(
      sampleSpec({
        slots: {
          'client-impl': 'class Client { /* real */ }',
          // toolkit-impl still missing
        },
      }),
      SLOT_MANIFEST,
    );
    assert.match(out, /`client-impl`.*✓ filled/);
    assert.match(out, /`toolkit-impl`.*✗ missing/);
    assert.match(out, /\*\*Missing required:\*\* `toolkit-impl`\./);
    assert.ok(!/\*\*Missing required:\*\*.+client-impl/.test(out));
  });

  it('treats whitespace-only slots as unfilled', () => {
    const out = buildSpecHeader(
      sampleSpec({ slots: { 'client-impl': '   \n  ' } }),
      SLOT_MANIFEST,
    );
    assert.match(out, /`client-impl`.*✗ missing/);
  });

  it('reports "none ✓" when every required slot is filled', () => {
    const out = buildSpecHeader(
      sampleSpec({
        slots: {
          'client-impl': 'real',
          'toolkit-impl': 'real',
        },
      }),
      SLOT_MANIFEST,
    );
    assert.match(out, /\*\*Missing required:\*\* none\. ✓/);
  });

  it('skips the slot checklist when manifest is an empty array', () => {
    const out = buildSpecHeader(sampleSpec(), []);
    assert.ok(!out.includes('Template-Slots'));
  });
});
