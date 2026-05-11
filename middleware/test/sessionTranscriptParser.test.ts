import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseSessionTranscript } from '@omadia/orchestrator-extras';

// Minimal renderer matching SessionLogger.renderTurn() — kept tiny on purpose
// so the round-trip is obvious. Any drift between parser and renderer should
// surface here first.
function renderTurn(args: {
  time: string;
  user: string;
  assistant: string;
  tools?: number;
  iterations?: number;
  entities?: Array<Record<string, unknown>>;
}): string {
  const telemetry =
    args.tools !== undefined || args.iterations !== undefined
      ? `\n*Telemetrie: tools=${String(args.tools ?? '?')}, iterations=${String(args.iterations ?? '?')}*\n`
      : '';
  const entitiesComment =
    args.entities && args.entities.length > 0
      ? `\n<!-- entities: ${JSON.stringify(args.entities)} -->\n`
      : '';
  return [
    `### ${args.time}Z`,
    '',
    '**User:**',
    '',
    args.user,
    '',
    '**Assistant:**',
    '',
    args.assistant,
    telemetry,
    entitiesComment,
    '',
    '---',
    '',
    '',
  ].join('\n');
}

describe('parseSessionTranscript', () => {
  it('extracts a single turn with telemetry and entity refs', () => {
    const md = `# Header\n\n---\n\n${renderTurn({
      time: '10:00:00',
      user: 'Wer?',
      assistant: 'Anna.',
      tools: 3,
      iterations: 2,
      entities: [
        { s: 'odoo', m: 'hr.employee', id: 42, n: 'Anna' },
        { s: 'confluence', m: 'confluence.page', id: '100', n: 'Wiki' },
      ],
    })}`;
    const turns = parseSessionTranscript('2026-04-18', md);
    assert.equal(turns.length, 1);
    const t = turns[0];
    assert.ok(t);
    assert.equal(t.time, '2026-04-18T10:00:00Z');
    assert.equal(t.userMessage, 'Wer?');
    assert.equal(t.assistantAnswer, 'Anna.');
    assert.equal(t.toolCalls, 3);
    assert.equal(t.iterations, 2);
    assert.equal(t.entityRefs.length, 2);
    assert.equal(t.entityRefs[0]?.id, 42);
    assert.equal(t.entityRefs[0]?.displayName, 'Anna');
  });

  it('handles multiple turns separated by --- inside a file', () => {
    const md = `# Header\n\n---\n\n${renderTurn({
      time: '10:00:00', user: 'Q1', assistant: 'A1',
    })}${renderTurn({
      time: '11:00:00', user: 'Q2', assistant: 'A2',
    })}`;
    const turns = parseSessionTranscript('2026-04-18', md);
    assert.equal(turns.length, 2);
    assert.deepEqual(turns.map((t) => t.time), [
      '2026-04-18T10:00:00Z',
      '2026-04-18T11:00:00Z',
    ]);
  });

  it('skips turns without a recognizable heading', () => {
    const md = `# Header\n\n---\n\nJust prose with no turn heading.\n`;
    assert.deepEqual(parseSessionTranscript('2026-04-18', md), []);
  });

  it('preserves assistant answers that contain markdown tables', () => {
    const assistant = '| a | b |\n|---|---|\n| 1 | 2 |';
    const md = `# Header\n\n---\n\n${renderTurn({
      time: '12:00:00', user: 'Q', assistant,
    })}`;
    const turns = parseSessionTranscript('2026-04-18', md);
    assert.equal(turns.length, 1);
    assert.ok(turns[0]?.assistantAnswer.includes('| a | b |'));
    assert.ok(turns[0]?.assistantAnswer.includes('| 1 | 2 |'));
  });

  it('tolerates missing telemetry', () => {
    const md = `# Header\n\n---\n\n${renderTurn({
      time: '10:00:00', user: 'Q', assistant: 'A',
    })}`;
    const t = parseSessionTranscript('2026-04-18', md)[0];
    assert.ok(t);
    assert.equal(t.toolCalls, undefined);
    assert.equal(t.iterations, undefined);
    assert.deepEqual(t.entityRefs, []);
  });

  it('silently drops malformed entity entries', () => {
    const md = `# Header\n\n---\n\n${renderTurn({
      time: '10:00:00', user: 'Q', assistant: 'A',
      entities: [
        { s: 'odoo', m: 'hr.employee', id: 1 },
        { s: 'unknown-system', m: 'x', id: 2 }, // bad system → dropped
        { m: 'only-model' },                    // missing id → dropped
      ],
    })}`;
    const t = parseSessionTranscript('2026-04-18', md)[0];
    assert.ok(t);
    assert.equal(t.entityRefs.length, 1);
    assert.equal(t.entityRefs[0]?.id, 1);
  });
});
