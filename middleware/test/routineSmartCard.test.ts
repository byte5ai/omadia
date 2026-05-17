import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildRoutineSmartCard } from '../src/plugins/routines/routineSmartCard.js';

const ROUTINE = { id: 'rt-1', name: 'HR Daily', cron: '0 9 * * *' } as const;

/**
 * Phase C.6 — Adaptive Card body assembly. The smart-card builder
 * frames every routine delivery with a header pill + facts + actions;
 * the body content can be either a single TextBlock with markdown
 * (legacy / format:'markdown' routines) or pre-built Adaptive Card
 * items (format:'adaptive-card' routines via C.6 renderer).
 */

describe('buildRoutineSmartCard — legacy body=markdown path', () => {
  it('wraps body markdown in a single TextBlock between header and FactSet', () => {
    const card = buildRoutineSmartCard({
      routine: ROUTINE,
      body: 'Hallo Welt',
    }) as Record<string, unknown>;
    const body = card['body'] as Array<Record<string, unknown>>;
    // header container + body TextBlock + FactSet = 3 entries
    assert.equal(body.length, 3);
    assert.equal(body[0]!['type'], 'Container');
    assert.equal(body[1]!['type'], 'TextBlock');
    assert.equal(body[1]!['text'], 'Hallo Welt');
    assert.equal(body[1]!['wrap'], true);
    assert.equal(body[2]!['type'], 'FactSet');
  });

  it('still includes pause/delete actions', () => {
    const card = buildRoutineSmartCard({
      routine: ROUTINE,
      body: 'x',
    }) as Record<string, unknown>;
    const actions = card['actions'] as Array<Record<string, unknown>>;
    assert.equal(actions.length, 2);
    assert.equal(actions[0]!['title'], 'Pausieren');
    assert.equal(actions[1]!['title'], 'Löschen');
  });
});

describe('buildRoutineSmartCard — Phase C.6 bodyItems path', () => {
  it('embeds bodyItems directly between header and FactSet (legacy body TextBlock omitted)', () => {
    const bodyItems = [
      { type: 'TextBlock', text: 'Intro', wrap: true },
      {
        type: 'Table',
        columns: [{ width: 1 }],
        firstRowAsHeader: true,
        rows: [],
      },
    ];
    const card = buildRoutineSmartCard({
      routine: ROUTINE,
      body: 'unused markdown fallback',
      bodyItems,
    }) as Record<string, unknown>;
    const body = card['body'] as Array<Record<string, unknown>>;
    // header + intro TextBlock + Table + FactSet = 4 entries
    assert.equal(body.length, 4);
    assert.equal(body[0]!['type'], 'Container');
    assert.equal(body[1]!['type'], 'TextBlock');
    assert.equal(body[1]!['text'], 'Intro');
    assert.equal(body[2]!['type'], 'Table');
    assert.equal(body[3]!['type'], 'FactSet');
  });

  it('falls back to body TextBlock when bodyItems is an empty array', () => {
    const card = buildRoutineSmartCard({
      routine: ROUTINE,
      body: 'fallback markdown',
      bodyItems: [],
    }) as Record<string, unknown>;
    const body = card['body'] as Array<Record<string, unknown>>;
    // Treats empty bodyItems same as omitted — render the markdown body.
    assert.equal(body.length, 3);
    assert.equal(body[1]!['type'], 'TextBlock');
    assert.equal(body[1]!['text'], 'fallback markdown');
  });

  it('preserves card frame (schema, version, actions) regardless of body path', () => {
    const card = buildRoutineSmartCard({
      routine: ROUTINE,
      body: 'x',
      bodyItems: [{ type: 'TextBlock', text: 'y', wrap: true }],
    }) as Record<string, unknown>;
    assert.equal(card['$schema'], 'http://adaptivecards.io/schemas/adaptive-card.json');
    assert.equal(card['type'], 'AdaptiveCard');
    assert.equal(card['version'], '1.5');
    const actions = card['actions'] as Array<Record<string, unknown>>;
    assert.equal(actions.length, 2);
  });
});
