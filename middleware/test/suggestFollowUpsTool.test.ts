import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { SuggestFollowUpsTool } from '@omadia/orchestrator';

describe('SuggestFollowUpsTool', () => {
  it('accepts 2 options and stores pending suggestions', async () => {
    const tool = new SuggestFollowUpsTool();
    const out = await tool.handle({
      options: [
        { label: 'Q1 2026', prompt: 'Top 5 Kunden nach Umsatz Q1 2026' },
        { label: 'Vorjahr', prompt: 'Top 5 Kunden nach Umsatz 2025' },
      ],
    });
    const parsed = JSON.parse(out) as { status: string; optionCount: number };
    assert.equal(parsed.status, 'follow_ups_scheduled');
    assert.equal(parsed.optionCount, 2);
    const pending = tool.takePending();
    assert.ok(pending);
    assert.equal(pending!.length, 2);
    assert.equal(pending![0]!.label, 'Q1 2026');
    assert.equal(pending![0]!.prompt, 'Top 5 Kunden nach Umsatz Q1 2026');
  });

  it('takePending clears state so the next call returns undefined', async () => {
    const tool = new SuggestFollowUpsTool();
    await tool.handle({
      options: [
        { label: 'A', prompt: 'Frage A' },
        { label: 'B', prompt: 'Frage B' },
      ],
    });
    assert.ok(tool.takePending());
    assert.equal(tool.takePending(), undefined);
  });

  it('rejects fewer than 2 options', async () => {
    const tool = new SuggestFollowUpsTool();
    const out = await tool.handle({
      options: [{ label: 'Solo', prompt: 'Einzige Variante' }],
    });
    assert.ok(out.startsWith('Error:'));
    assert.equal(tool.takePending(), undefined);
  });

  it('rejects more than 4 options', async () => {
    const tool = new SuggestFollowUpsTool();
    const out = await tool.handle({
      options: [
        { label: 'A', prompt: 'Frage A' },
        { label: 'B', prompt: 'Frage B' },
        { label: 'C', prompt: 'Frage C' },
        { label: 'D', prompt: 'Frage D' },
        { label: 'E', prompt: 'Frage E' },
      ],
    });
    assert.ok(out.startsWith('Error:'));
  });

  it('rejects duplicate labels case-insensitively', async () => {
    const tool = new SuggestFollowUpsTool();
    const out = await tool.handle({
      options: [
        { label: 'Q1', prompt: 'Umsatz Q1' },
        { label: 'q1', prompt: 'Umsatz Q1 nochmal' },
      ],
    });
    assert.ok(out.startsWith('Error:'));
    assert.match(out, /duplicate label/);
  });

  it('rejects label over 40 chars', async () => {
    const tool = new SuggestFollowUpsTool();
    const out = await tool.handle({
      options: [
        { label: 'x'.repeat(41), prompt: 'Eine gültige Frage' },
        { label: 'OK', prompt: 'Eine andere Frage' },
      ],
    });
    assert.ok(out.startsWith('Error:'));
  });

  it('rejects prompt under 3 chars', async () => {
    const tool = new SuggestFollowUpsTool();
    const out = await tool.handle({
      options: [
        { label: 'A', prompt: 'ok' },
        { label: 'B', prompt: 'Andere Frage mit Text' },
      ],
    });
    assert.ok(out.startsWith('Error:'));
  });

  it('rejects prompt over 500 chars', async () => {
    const tool = new SuggestFollowUpsTool();
    const out = await tool.handle({
      options: [
        { label: 'A', prompt: 'x'.repeat(501) },
        { label: 'B', prompt: 'Normal' },
      ],
    });
    assert.ok(out.startsWith('Error:'));
  });

  it('last call wins on repeated invocations within one turn', async () => {
    const tool = new SuggestFollowUpsTool();
    await tool.handle({
      options: [
        { label: 'Erste', prompt: 'Erste Variante' },
        { label: 'Zweite', prompt: 'Zweite Variante' },
      ],
    });
    await tool.handle({
      options: [
        { label: 'X', prompt: 'Neue Variante X' },
        { label: 'Y', prompt: 'Neue Variante Y' },
      ],
    });
    const pending = tool.takePending();
    assert.equal(pending!.length, 2);
    assert.equal(pending![0]!.label, 'X');
  });

  it('rejects non-object input', async () => {
    const tool = new SuggestFollowUpsTool();
    const out = await tool.handle(undefined);
    assert.ok(out.startsWith('Error:'));
  });
});
