import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { dialogParent } from '../src/dialogParent.ts';

const win = (destroyed: boolean) => ({ isDestroyed: () => destroyed });

describe('dialogParent', () => {
  it('attaches to a live window, skipping a destroyed one', () => {
    const live = win(false);
    assert.equal(dialogParent([win(true), live]), live);
  });

  it('has no parent when no window exists', () => {
    assert.equal(dialogParent([]), undefined);
    assert.equal(dialogParent([win(true)]), undefined);
  });
});
