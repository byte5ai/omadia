// Spec 2042 §5.14, criterion 31 — every decoration is declared once with a
// justification and its channels; the SDK refuses the rest.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

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

  it('fails when the SDK attaches a decoration id that is not declared', () => {
    // Static guard: ids passed to `decoration: '<id>'` / `decorationId: '<id>'`
    // anywhere in the SDK sources must be declared.
    const dir = join(process.cwd(), 'packages/harness-channel-sdk/src');
    const declared = new Set(DECORATION_REGISTRY.map((d) => d.id));
    const used: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'decorations.ts')) {
      const source = readFileSync(join(dir, file), 'utf8');
      for (const m of source.matchAll(/decoration(?:Id)?\s*:\s*'([a-z_]+)'/g)) used.push(m[1] ?? '');
    }
    for (const id of used) assert.ok(declared.has(id), `undeclared decoration '${id}'`);
  });
});
