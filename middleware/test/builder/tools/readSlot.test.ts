import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { fillSlotTool } from '../../../src/plugins/builder/tools/fillSlot.js';
import { readSlotTool } from '../../../src/plugins/builder/tools/readSlot.js';
import {
  createBuilderToolHarness,
  type BuilderToolHarness,
} from '../fixtures/builderToolHarness.js';

describe('readSlotTool', () => {
  let harness: BuilderToolHarness;

  beforeEach(async () => {
    harness = await createBuilderToolHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('returns the raw slot source 1:1 with byte count after a fill_slot call', async () => {
    const source = "const x = 1;\nconst y = 'hä';\n";
    await fillSlotTool.run({ slotKey: 'activate-body', source }, harness.context());

    const result = await readSlotTool.run({ slotKey: 'activate-body' }, harness.context());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.slotKey, 'activate-body');
    assert.equal(result.source, source);
    assert.equal(result.bytes, Buffer.byteLength(source, 'utf8'));
  });

  it('reads the latest source after an overwrite', async () => {
    await fillSlotTool.run({ slotKey: 'activate-body', source: 'old();' }, harness.context());
    await fillSlotTool.run({ slotKey: 'activate-body', source: 'new();' }, harness.context());

    const result = await readSlotTool.run({ slotKey: 'activate-body' }, harness.context());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.source, 'new();');
  });

  it('does not reformat, trim, or strip comments', async () => {
    const source = '  // leading comment\n  doThing();  \n\n';
    await fillSlotTool.run({ slotKey: 'toolkit-impl', source }, harness.context());

    const result = await readSlotTool.run({ slotKey: 'toolkit-impl' }, harness.context());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.source, source, 'source must come back identical (incl. whitespace + comments)');
  });

  it('returns ok=false with available slot keys on miss', async () => {
    await fillSlotTool.run({ slotKey: 'activate-body', source: 'a();' }, harness.context());
    await fillSlotTool.run({ slotKey: 'toolkit-impl', source: 'b();' }, harness.context());

    const result = await readSlotTool.run({ slotKey: 'client-impl' }, harness.context());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /slot 'client-impl' is not filled/);
    assert.deepEqual(result.available, ['activate-body', 'toolkit-impl']);
  });

  it('returns an empty available list on miss when the draft has no slots yet', async () => {
    const result = await readSlotTool.run({ slotKey: 'activate-body' }, harness.context());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.available, []);
  });

  it('returns ok=false when the draft does not exist', async () => {
    const ctx = { ...harness.context(), draftId: 'no-such-draft' };
    const result = await readSlotTool.run({ slotKey: 'activate-body' }, ctx);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /not found/);
  });

  it('rejects an invalid slotKey via Zod', () => {
    assert.throws(() => readSlotTool.input.parse({ slotKey: 'BadKey' }));
    assert.throws(() => readSlotTool.input.parse({ slotKey: '0lead' }));
    assert.throws(() => readSlotTool.input.parse({ slotKey: '' }));
  });

  it('has no side effects — no slot_patch event, no rebuild scheduled, no tsc gate', async () => {
    await fillSlotTool.run({ slotKey: 'activate-body', source: 'a();' }, harness.context());
    const eventsBefore = harness.events.length;
    const rebuildsBefore = harness.rebuilds.length;
    const tscBefore = harness.slotTypecheckCalls.length;

    await readSlotTool.run({ slotKey: 'activate-body' }, harness.context());

    assert.equal(harness.events.length, eventsBefore);
    assert.equal(harness.rebuilds.length, rebuildsBefore);
    assert.equal(harness.slotTypecheckCalls.length, tscBefore);
  });

  it('reports bytes as utf-8 length, not character count', async () => {
    // 'ä' is 2 bytes in utf-8, 'π' is 2 bytes, '𝄞' is 4 bytes.
    const source = 'äπ𝄞';
    await fillSlotTool.run({ slotKey: 'helper-fns', source }, harness.context());

    const result = await readSlotTool.run({ slotKey: 'helper-fns' }, harness.context());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.bytes, Buffer.byteLength(source, 'utf8'));
    assert.notEqual(result.bytes, source.length, 'bytes must differ from JS char count for multibyte chars');
  });
});
