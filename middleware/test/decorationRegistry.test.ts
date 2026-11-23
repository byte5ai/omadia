// Spec 2042 §5.14, criterion 31 — every decoration is declared once with a
// justification and its channels; the SDK refuses the rest.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DECORATION_REGISTRY,
  REMOVED_DECORATIONS,
  admitDecorations,
  decorationsFor,
  isDecorationAllowed,
} from '@omadia/channel-sdk';

// Adding a decoration is a product decision (spec §5.14): it needs a
// justification in the registry AND a deliberate edit of this list in review.
const EXPECTED_IDS = [
  'ai_disclosure_line',
  'ai_disclosure_chip',
  'decision_card',
  'facilitation_poll',
  'question_card',
  'follow_up_options',
  'consent_card',
  'mcp_input_form',
  'routine_list',
  'answer_details',
];

describe('decoration registry', () => {
  it('declares exactly the reviewed decorations', () => {
    assert.deepEqual(
      DECORATION_REGISTRY.map((d) => d.id),
      EXPECTED_IDS,
      'a new decoration needs a registry entry with a justification and a reviewed update of EXPECTED_IDS',
    );
  });

  it('gives every decoration a justification and at least one channel', () => {
    for (const d of DECORATION_REGISTRY) {
      assert.ok(d.purpose.length > 10, `${d.id}: purpose`);
      if (d.justification.kind === 'legal') assert.ok(d.justification.basis.length > 5, `${d.id}: legal basis`);
      else assert.ok(d.justification.action.length > 10, `${d.id}: next action`);
      assert.ok(d.channels === '*' || d.channels.length > 0, `${d.id}: channels`);
    }
  });

  it('keeps removed elements out of the registry', () => {
    const ids = new Set(DECORATION_REGISTRY.map((d) => d.id));
    for (const removed of REMOVED_DECORATIONS) assert.equal(ids.has(removed), false, removed);
  });

  it('admits declared decorations in their channels only', () => {
    assert.equal(isDecorationAllowed('ai_disclosure_line', 'telegram'), true);
    assert.equal(isDecorationAllowed('ai_disclosure_chip', 'teams'), true);
    assert.equal(isDecorationAllowed('ai_disclosure_chip', 'telegram'), false);
    assert.equal(isDecorationAllowed('decision_card', 'telegram'), false);
    assert.deepEqual(
      decorationsFor('telegram').map((d) => d.id),
      ['ai_disclosure_line'],
    );
  });

  it('criterion 31: no decoration id is used in SDK or kernel source without a registry entry', () => {
    const declared = new Set(DECORATION_REGISTRY.map((d) => d.id));
    const removed = new Set<string>(REMOVED_DECORATIONS);
    const offenders = decorationIdsInSource()
      .filter((u) => !declared.has(u.id))
      .map((u) => `${u.file}: '${u.id}' ${removed.has(u.id) ? 'is a removed decoration' : 'has no registry entry'}`);
    assert.deepEqual(offenders, [], 'declare the decoration in decorations.ts (with a justification) or drop it');
  });

  it('criterion 31: the source scan catches an undeclared or removed decoration id', () => {
    assert.deepEqual(
      decorationIdsIn('x.ts', "admitDecorations('web', [{ id: 'status_banner' }]); const b = 'verifier_badge';").map((u) => u.id).sort(),
      ['status_banner', 'verifier_badge'],
    );
    assert.deepEqual(decorationIdsIn('x.ts', "isDecorationAllowed('consulted_footer', 'teams')").map((u) => u.id), ['consulted_footer']);
    assert.deepEqual(decorationIdsIn('x.ts', "const kind = 'adaptive_card';"), [], 'a generic *_card literal is not a decoration');
  });

  it('refuses undeclared, removed and foreign-channel decorations', () => {
    const seen: string[] = [];
    const result = admitDecorations(
      'telegram',
      [
        { id: 'ai_disclosure_line' },
        { id: 'status_banner' },
        { id: 'verifier_badge' },
        { id: 'decision_card' },
      ],
      (r) => seen.push(`${r.id}:${r.reason}`),
    );
    assert.deepEqual(result.admitted.map((d) => d.id), ['ai_disclosure_line']);
    assert.deepEqual(seen, [
      'status_banner:undeclared',
      'verifier_badge:removed',
      'decision_card:channel_not_declared',
    ]);
  });
});

/**
 * Criterion 31 — the source scan the registry's header promises. A decoration
 * id is used where it is handed to the registry API (`admitDecorations`,
 * `isDecorationAllowed`, `getDecoration`) or where a literal names a status
 * element (`*_chip`, `*_badge`, `*_footer`, `*_banner`, `*_reaction`,
 * `*_buttons`, `*_status_line`). The registry file itself is the definition.
 */
const MIDDLEWARE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_FILE = 'packages/harness-channel-sdk/src/decorations.ts';
const API_CALL = /\b(admitDecorations|isDecorationAllowed|getDecoration)\(([^;]*?)\)\s*[;,)\n]/g;
const STATUS_LITERAL = /'([a-z][a-z0-9]*(?:_[a-z0-9]+)*_(?:chip|badge|footer|banner|reaction|buttons|status_line))'/g;

interface DecorationUse {
  readonly file: string;
  readonly id: string;
}

function decorationIdsIn(file: string, text: string): DecorationUse[] {
  const ids = new Set<string>();
  for (const [, fn, args = ''] of text.matchAll(API_CALL)) {
    // admitDecorations names the channel first and the ids in `id:`; the
    // other two take the id as their first argument.
    const pattern = fn === 'admitDecorations' ? /id:\s*'([a-z][a-z0-9_]*)'/g : /^\s*'([a-z][a-z0-9_]*)'/g;
    for (const m of args.matchAll(pattern)) ids.add(m[1] as string);
  }
  for (const m of text.matchAll(STATUS_LITERAL)) ids.add(m[1] as string);
  return [...ids].map((id) => ({ file, id }));
}

function decorationIdsInSource(): DecorationUse[] {
  const out: DecorationUse[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts') && !name.endsWith('.test.ts')) {
        const rel = path.relative(MIDDLEWARE, full).split(path.sep).join('/');
        if (rel !== REGISTRY_FILE) out.push(...decorationIdsIn(rel, readFileSync(full, 'utf8')));
      }
    }
  };
  walk(path.join(MIDDLEWARE, 'src'));
  for (const pkg of readdirSync(path.join(MIDDLEWARE, 'packages'))) {
    const src = path.join(MIDDLEWARE, 'packages', pkg, 'src');
    if (statSync(src, { throwIfNoEntry: false })?.isDirectory()) walk(src);
  }
  return out;
}
