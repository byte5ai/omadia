import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { AskUserChoiceTool } from '@omadia/orchestrator';

describe('AskUserChoiceTool', () => {
  it('accepts 2 options and stores a pending choice with default value = label', async () => {
    const tool = new AskUserChoiceTool();
    const out = await tool.handle({
      question: 'Welches Modul?',
      options: [{ label: 'Sales' }, { label: 'POS' }],
    });
    const parsed = JSON.parse(out) as { status: string; optionCount: number };
    assert.equal(parsed.status, 'choice_card_scheduled');
    assert.equal(parsed.optionCount, 2);
    assert.ok(tool.hasPending());
    const pending = tool.takePending();
    assert.ok(pending);
    assert.equal(pending!.question, 'Welches Modul?');
    assert.deepEqual(pending!.options, [
      { label: 'Sales', value: 'Sales' },
      { label: 'POS', value: 'POS' },
    ]);
  });

  it('takePending clears state so the next call returns undefined', async () => {
    const tool = new AskUserChoiceTool();
    await tool.handle({
      question: 'Testfrage',
      options: [{ label: 'A' }, { label: 'B' }],
    });
    assert.ok(tool.takePending());
    assert.equal(tool.takePending(), undefined);
    assert.equal(tool.hasPending(), false);
  });

  it('keeps explicit `value` distinct from label', async () => {
    const tool = new AskUserChoiceTool();
    await tool.handle({
      question: 'Welche Region?',
      options: [
        { label: 'DACH', value: 'region_dach' },
        { label: 'EU', value: 'region_eu' },
      ],
    });
    const pending = tool.takePending();
    assert.deepEqual(pending!.options, [
      { label: 'DACH', value: 'region_dach' },
      { label: 'EU', value: 'region_eu' },
    ]);
  });

  it('passes rationale through when provided', async () => {
    const tool = new AskUserChoiceTool();
    await tool.handle({
      question: 'Welches Modul?',
      rationale: 'Beide Module tracken Umsatz.',
      options: [{ label: 'Sales' }, { label: 'POS' }],
    });
    const pending = tool.takePending();
    assert.equal(pending!.rationale, 'Beide Module tracken Umsatz.');
  });

  it('rejects fewer than 2 options', async () => {
    const tool = new AskUserChoiceTool();
    const out = await tool.handle({
      question: 'Nur eins?',
      options: [{ label: 'Solo' }],
    });
    assert.ok(out.startsWith('Error:'));
    assert.equal(tool.hasPending(), false);
  });

  it('rejects more than 4 options', async () => {
    const tool = new AskUserChoiceTool();
    const out = await tool.handle({
      question: 'Zu viele?',
      options: [
        { label: 'A' },
        { label: 'B' },
        { label: 'C' },
        { label: 'D' },
        { label: 'E' },
      ],
    });
    assert.ok(out.startsWith('Error:'));
  });

  it('rejects duplicate labels (case-insensitive)', async () => {
    const tool = new AskUserChoiceTool();
    const out = await tool.handle({
      question: 'Doppel?',
      options: [{ label: 'Sales' }, { label: 'sales' }],
    });
    assert.ok(out.startsWith('Error:'));
    assert.match(out, /duplicate label/);
  });

  it('rejects label over 40 chars', async () => {
    const tool = new AskUserChoiceTool();
    const longLabel = 'x'.repeat(41);
    const out = await tool.handle({
      question: 'Lang?',
      options: [{ label: longLabel }, { label: 'OK' }],
    });
    assert.ok(out.startsWith('Error:'));
  });

  it('rejects question under 3 chars', async () => {
    const tool = new AskUserChoiceTool();
    const out = await tool.handle({
      question: 'x',
      options: [{ label: 'A' }, { label: 'B' }],
    });
    assert.ok(out.startsWith('Error:'));
  });

  it('rejects non-object input', async () => {
    const tool = new AskUserChoiceTool();
    const out = await tool.handle(undefined);
    assert.ok(out.startsWith('Error:'));
  });

  it('truncates value to 200 chars when explicit value is too long', async () => {
    const tool = new AskUserChoiceTool();
    // 200-char value is accepted; anything over that fails schema validation.
    // Verify schema rejects > 200 chars.
    const out = await tool.handle({
      question: 'Welcher Wert?',
      options: [
        { label: 'A', value: 'x'.repeat(201) },
        { label: 'B' },
      ],
    });
    assert.ok(out.startsWith('Error:'));
  });

  it('first call wins when handle is called twice before drain', async () => {
    // Behavior change in OB-28: parallel tool dispatch made the previous
    // last-call-wins semantics non-deterministic (two concurrent handle()
    // calls would race for the `this.pending` slot). The Tool spec already
    // states "max 1× per turn", so we now enforce first-call-wins and let
    // the second call get a no-op signal.
    const tool = new AskUserChoiceTool();
    await tool.handle({
      question: 'Erste?',
      options: [{ label: 'A' }, { label: 'B' }],
    });
    const secondOut = await tool.handle({
      question: 'Zweite?',
      options: [{ label: 'X' }, { label: 'Y' }],
    });
    const pending = tool.takePending();
    assert.equal(pending!.question, 'Erste?');
    assert.equal(pending!.options[0]!.label, 'A');
    // The model gets a clear signal that its second call was skipped, so
    // it can stop trying or surface that as text in the answer.
    assert.match(secondOut, /choice_card_already_scheduled/);
  });

  it('second call does not overwrite first even with invalid input', async () => {
    // Guard short-circuits before schema validation: a malformed second
    // call must not be able to clobber a valid first one either.
    const tool = new AskUserChoiceTool();
    await tool.handle({
      question: 'Erste?',
      options: [{ label: 'A' }, { label: 'B' }],
    });
    const secondOut = await tool.handle({ garbage: true });
    const pending = tool.takePending();
    assert.equal(pending!.question, 'Erste?');
    assert.match(secondOut, /choice_card_already_scheduled/);
  });
});
