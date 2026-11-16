import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryMemoryStore } from '../packages/harness-memory/src/inMemoryMemoryStore.js';
import { MemoryToolHandler } from '../packages/harness-memory/src/memoryTool.js';

/**
 * #1830 — `str_replace` must write `new_str` literally. Passed as a string to
 * `String.prototype.replace`, `new_str` had its `$` sequences evaluated as
 * replacement patterns, so prices, shell snippets and regexes were stored
 * differently from what the model wrote, without any error.
 */

const NOTE = '/memories/test/dollar.md';

async function replaceIn(content: string, oldStr: string, newStr: string): Promise<string> {
  const store = new InMemoryMemoryStore();
  await store.createFile(NOTE, content);
  const result = await new MemoryToolHandler(store).handle({
    command: 'str_replace',
    path: NOTE,
    old_str: oldStr,
    new_str: newStr,
  });
  assert.match(result, /^The memory file has been edited\./);
  return store.readFile(NOTE);
}

describe('memory tool str_replace writes new_str literally (#1830)', () => {
  it('keeps `$$` and `$&` as written', async () => {
    assert.equal(
      await replaceIn('Codewort Birne', 'Birne', 'Preis $$5 und $& Rest'),
      'Codewort Preis $$5 und $& Rest',
    );
  });

  it("keeps `` $` `` and `$'` as written", async () => {
    assert.equal(
      await replaceIn('vor Birne nach', 'Birne', "a $` b $' c"),
      "vor a $` b $' c nach",
    );
  });

  it('keeps `$1` and `$<name>` as written', async () => {
    assert.equal(
      await replaceIn('Codewort Birne', 'Birne', 'sed s/(a)/$1/ $<name>'),
      'Codewort sed s/(a)/$1/ $<name>',
    );
  });

  it('still replaces plain text', async () => {
    assert.equal(await replaceIn('Codewort Birne', 'Birne', 'Apfel'), 'Codewort Apfel');
  });
});
