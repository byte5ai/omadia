import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { turnContext } from '@omadia/orchestrator';

describe('turnContext', () => {
  it('returns undefined outside any run/enter scope', () => {
    assert.equal(turnContext.current(), undefined);
  });

  it('propagates turnId through awaits inside run()', async () => {
    await turnContext.run('turn-A', async () => {
      assert.equal(turnContext.current(), 'turn-A');
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(turnContext.current(), 'turn-A');
    });
    // After run() returns, context is restored to whatever it was before.
    assert.equal(turnContext.current(), undefined);
  });

  it('isolates concurrent runs (no cross-contamination)', async () => {
    const seen: string[] = [];
    await Promise.all([
      turnContext.run('A', async () => {
        await new Promise((r) => setTimeout(r, 10));
        seen.push(`A:${String(turnContext.current())}`);
      }),
      turnContext.run('B', async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(`B:${String(turnContext.current())}`);
      }),
      turnContext.run('C', async () => {
        seen.push(`C:${String(turnContext.current())}`);
      }),
    ]);
    assert.deepEqual(seen.sort(), ['A:A', 'B:B', 'C:C']);
  });

  it('enter() binds for the current async resource chain', async () => {
    await (async () => {
      turnContext.enter('turn-enter');
      assert.equal(turnContext.current(), 'turn-enter');
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(turnContext.current(), 'turn-enter');
    })();
  });
});
