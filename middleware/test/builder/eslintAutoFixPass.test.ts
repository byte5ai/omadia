import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { ESLint } from 'eslint';

import {
  _internal,
  buildAutoFixConfig,
  eslintAutoFixBundle,
  extractPersistableSlotFixes,
} from '../../src/plugins/builder/eslintAutoFixPass.js';

/**
 * The auto-fix pass is intentionally narrow: type-info-free,
 * auto-fixable style rules only. These tests pin the rule set so a
 * future "let's add no-floating-promises" change has to update the
 * tests deliberately (and notice the type-info dependency).
 */
describe('eslintAutoFixPass', () => {
  beforeEach(() => {
    _internal.resetCachedEslint();
  });

  it('rewrites `let` → `const` for never-reassigned bindings (prefer-const)', async () => {
    const files = new Map<string, Buffer>([
      [
        'plugin.ts',
        Buffer.from(
          ['let x = 1;', 'export const y = x + 1;'].join('\n') + '\n',
        ),
      ],
    ]);
    const out = await eslintAutoFixBundle(files);
    const fixed = out.get('plugin.ts')?.toString('utf-8');
    assert.ok(fixed !== undefined);
    assert.match(fixed, /^const x = 1;/m);
  });

  it('rewrites `var` → `let`/`const` (no-var)', async () => {
    const files = new Map<string, Buffer>([
      [
        'toolkit.ts',
        Buffer.from(
          ['var counter = 0;', 'counter += 1;', 'export { counter };'].join('\n') + '\n',
        ),
      ],
    ]);
    const out = await eslintAutoFixBundle(files);
    const fixed = out.get('toolkit.ts')?.toString('utf-8');
    assert.ok(fixed !== undefined);
    assert.doesNotMatch(fixed, /\bvar\b/);
  });

  it('preserves binary buffers (non-fixable extensions)', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const files = new Map<string, Buffer>([
      ['assets/logo.png', png],
      ['manifest.yaml', Buffer.from('id: x\n')],
    ]);
    const out = await eslintAutoFixBundle(files);
    assert.equal(out.get('assets/logo.png'), png);
    assert.equal(
      out.get('manifest.yaml')?.toString('utf-8'),
      'id: x\n',
    );
  });

  it('returns the original buffer when ESLint reports nothing fixable', async () => {
    const clean = Buffer.from('export const greeting = "hi";\n');
    const files = new Map<string, Buffer>([['plugin.ts', clean]]);
    const out = await eslintAutoFixBundle(files);
    assert.equal(out.get('plugin.ts'), clean);
  });

  it('falls through (returns original) on parse errors so tsc owns the diagnostic', async () => {
    // Half-baked TypeScript — ESLint's parser will throw. The pass must
    // not crash the pipeline; it returns the original buffer and lets
    // tsc surface the real syntax error with line/col.
    const broken = Buffer.from('export const x = (\nlet ');
    const files = new Map<string, Buffer>([['plugin.ts', broken]]);
    const out = await eslintAutoFixBundle(files);
    assert.equal(out.get('plugin.ts'), broken);
  });

  it('buildAutoFixConfig wires the type-info-free baseline rules', () => {
    const cfg = buildAutoFixConfig();
    // Find the config block that has rules — tseslint.config flattens
    // inputs into an array; our single config block carries the rules.
    const withRules = cfg.find((c) => c.rules !== undefined);
    assert.ok(withRules !== undefined);
    const rules = withRules.rules ?? {};
    assert.equal(rules['prefer-const'], 'error');
    assert.equal(rules['no-var'], 'error');
    assert.equal(rules['no-useless-escape'], 'error');
    // Type-aware rules must NOT be in the baseline — they need
    // parserOptions.project which is unavailable in-memory.
    assert.equal(
      rules['@typescript-eslint/no-floating-promises'],
      undefined,
      'type-aware rules require an on-disk tsconfig and must not run in the auto-fix pass',
    );
  });

  it('accepts a custom ESLint instance via opts.eslint', async () => {
    const custom = new ESLint({
      fix: true,
      overrideConfigFile: true,
      overrideConfig: buildAutoFixConfig({
        // Disable everything in the custom config so the pass becomes
        // a no-op even on let → const.
        'prefer-const': 'off',
        'no-var': 'off',
        'no-useless-escape': 'off',
      }),
    });
    const files = new Map<string, Buffer>([
      ['plugin.ts', Buffer.from('let x = 1; export { x };\n')],
    ]);
    const out = await eslintAutoFixBundle(files, { eslint: custom });
    assert.match(
      out.get('plugin.ts')!.toString('utf-8'),
      /\blet x = 1;/,
      'custom ESLint config disabled all rules — `let` should survive',
    );
  });
});

/**
 * OB-46 — extractPersistableSlotFixes covers the diff-detection that
 * decides which slots get written back to the DraftStore. The pipeline
 * test (slotTypecheckPipeline.test.ts) covers the persist + emit path
 * end-to-end; these unit cases pin the safety filters.
 */
describe('extractPersistableSlotFixes', () => {
  function file(body: string): Buffer {
    return Buffer.from(body, 'utf-8');
  }

  function makeSlotFile(slotKey: string, body: string): string {
    return [
      'export const before = 1;',
      `// #region builder:${slotKey}`,
      body,
      '// #endregion',
      'export const after = 2;',
      '',
    ].join('\n');
  }

  it('returns the post-fix body when ESLint changed the slot region', () => {
    const preFile = makeSlotFile('activate-body', 'let x = 1;\nexport { x };');
    const postFile = makeSlotFile('activate-body', 'const x = 1;\nexport { x };');
    const fixes = extractPersistableSlotFixes({
      preFixFiles: new Map([['plugin.ts', file(preFile)]]),
      postFixFiles: new Map([['plugin.ts', file(postFile)]]),
      originalSlots: { 'activate-body': 'let x = 1;\nexport { x };' },
    });
    assert.equal(fixes.length, 1);
    assert.equal(fixes[0]!.slotKey, 'activate-body');
    assert.equal(fixes[0]!.fixedSource, 'const x = 1;\nexport { x };');
    assert.equal(fixes[0]!.originalSource, 'let x = 1;\nexport { x };');
  });

  it('skips slots whose original text contains placeholders ({{TOKEN}})', () => {
    // Slot text has {{AGENT_ID}} — codegen step 5c resolves it before
    // ESLint runs, so the post-fix body would be the resolved string.
    // Persisting that would silently lose the placeholder reference;
    // the safety filter must skip these slots.
    const preFile = makeSlotFile(
      'log-init',
      "let msg = 'agent de.byte5.agent.x ready';",
    );
    const postFile = makeSlotFile(
      'log-init',
      "const msg = 'agent de.byte5.agent.x ready';",
    );
    const fixes = extractPersistableSlotFixes({
      preFixFiles: new Map([['plugin.ts', file(preFile)]]),
      postFixFiles: new Map([['plugin.ts', file(postFile)]]),
      originalSlots: {
        'log-init': "let msg = 'agent {{AGENT_ID}} ready';",
      },
    });
    assert.equal(fixes.length, 0);
  });

  it('emits no fix when ESLint did not touch the slot region', () => {
    const preFile = makeSlotFile('helper', 'export function f() { return 1; }');
    const postFile = preFile; // unchanged
    const fixes = extractPersistableSlotFixes({
      preFixFiles: new Map([['plugin.ts', file(preFile)]]),
      postFixFiles: new Map([['plugin.ts', file(postFile)]]),
      originalSlots: { helper: 'export function f() { return 1; }' },
    });
    assert.equal(fixes.length, 0);
  });

  it('is idempotent — second pass on already-fixed slot produces no fix', () => {
    const fixed = makeSlotFile('helper', 'const f = () => 1;');
    const fixes = extractPersistableSlotFixes({
      preFixFiles: new Map([['plugin.ts', file(fixed)]]),
      postFixFiles: new Map([['plugin.ts', file(fixed)]]),
      originalSlots: { helper: 'const f = () => 1;' },
    });
    assert.equal(fixes.length, 0);
  });

  it('handles multiple slots across multiple files independently', () => {
    const pluginPre = makeSlotFile('activate-body', 'let a = 1;');
    const pluginPost = makeSlotFile('activate-body', 'const a = 1;');
    const toolkitPre = makeSlotFile('toolkit-impl', 'let b = 2;');
    const toolkitPost = makeSlotFile('toolkit-impl', 'const b = 2;');
    const fixes = extractPersistableSlotFixes({
      preFixFiles: new Map([
        ['plugin.ts', file(pluginPre)],
        ['toolkit.ts', file(toolkitPre)],
      ]),
      postFixFiles: new Map([
        ['plugin.ts', file(pluginPost)],
        ['toolkit.ts', file(toolkitPost)],
      ]),
      originalSlots: {
        'activate-body': 'let a = 1;',
        'toolkit-impl': 'let b = 2;',
      },
    });
    assert.equal(fixes.length, 2);
    const byKey = Object.fromEntries(fixes.map((f) => [f.slotKey, f.fixedSource]));
    assert.equal(byKey['activate-body'], 'const a = 1;');
    assert.equal(byKey['toolkit-impl'], 'const b = 2;');
  });

  it('ignores slots not declared in originalSlots (codegen-managed slots)', () => {
    // `external-reads-imports` is auto-managed by codegen — it's not
    // in `draft.slots`, so even if the file has a marker for it we
    // must not try to persist anything for that key.
    const preFile = makeSlotFile('external-reads-imports', '');
    const postFile = makeSlotFile('external-reads-imports', '// fixed');
    const fixes = extractPersistableSlotFixes({
      preFixFiles: new Map([['plugin.ts', file(preFile)]]),
      postFixFiles: new Map([['plugin.ts', file(postFile)]]),
      originalSlots: { /* no entry for the codegen-managed key */ },
    });
    assert.equal(fixes.length, 0);
  });

  it('treats binary files / non-text extensions as carrying no slots', () => {
    // PNG buffer with `// #region builder:foo\n…` bytes by accident
    // must NOT be parsed as containing a slot. The text-extension
    // filter exists exactly for this paranoia.
    const fakePng = Buffer.from(
      '// #region builder:fake\nshould-be-ignored\n// #endregion',
    );
    const fixes = extractPersistableSlotFixes({
      preFixFiles: new Map([['assets/logo.png', fakePng]]),
      postFixFiles: new Map([['assets/logo.png', fakePng]]),
      originalSlots: { fake: 'whatever' },
    });
    assert.equal(fixes.length, 0);
  });
});
