/**
 * `ToolReplayLedger` — the per-request record of what each tool call of the
 * first run returned, and `RequestReceipts`, the request's one privacy
 * receipt across every pass.
 *
 * The first run RECORDS; a verifier re-entry REPLAYS. Entries are keyed by
 * seam (orchestrator, a sub-agent, the standalone dispatcher), tool name and
 * canonical input, and read through per-key cursors that `beginReentry`
 * resets, so a resample followed by a correction retry replays the first run
 * twice. A call the first run did not make runs on a re-entry only when it is
 * read-only; any other miss is refused and marks the re-entry abandoned.
 * Independently of re-entries, a call whose outcome is unknown (it threw) is
 * never repeated identically within the request unless it is read-only.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PrivacyReceipt } from '@omadia/plugin-api';

import {
  ToolReplayAbortError,
  ToolReplayLedger,
  replayMissNotice,
} from '../packages/harness-orchestrator/src/toolReplayLedger.js';
import {
  RequestReceipts,
  mergePrivacyReceipts,
} from '../packages/harness-orchestrator/src/requestReceipts.js';

const WRITE = { readOnly: false } as const;
const READ = { readOnly: true } as const;
const INPUT = { customer: 'K-1001', amount: 1200 };

describe('ToolReplayLedger — record, then replay', () => {
  it('the first run executes every call and never replays, identical calls included', () => {
    const ledger = new ToolReplayLedger();
    assert.equal(ledger.mode, 'record');
    for (let i = 0; i < 2; i += 1) {
      assert.deepEqual(ledger.decide('orchestrator', 'create_invoice', INPUT, WRITE), { action: 'execute' });
      ledger.record('orchestrator', 'create_invoice', INPUT, { kind: 'result', value: `r${String(i)}` });
    }
    assert.equal(ledger.abortedTool, undefined);
  });

  it('a re-entry replays recorded results in order; a further identical write is a miss', () => {
    const ledger = new ToolReplayLedger();
    ledger.record('orchestrator', 'create_invoice', INPUT, { kind: 'result', value: 'first' });
    ledger.record('orchestrator', 'create_invoice', INPUT, { kind: 'result', value: 'second' });

    ledger.beginReentry();

    assert.equal(ledger.mode, 'replay');
    const one = ledger.decide('orchestrator', 'create_invoice', INPUT, WRITE);
    const two = ledger.decide('orchestrator', 'create_invoice', INPUT, WRITE);
    assert.deepEqual([one, two], [
      { action: 'replay', record: { kind: 'result', value: 'first' } },
      { action: 'replay', record: { kind: 'result', value: 'second' } },
    ]);
    assert.deepEqual(ledger.decide('orchestrator', 'create_invoice', INPUT, WRITE), { action: 'refuse-miss' });
    assert.equal(ledger.abortedTool, 'create_invoice');
  });

  it('beginReentry resets every cursor and the abort: a second re-entry replays run 1 again', () => {
    const ledger = new ToolReplayLedger();
    ledger.record('orchestrator', 'create_invoice', INPUT, { kind: 'result', value: 'run1' });
    ledger.beginReentry();
    ledger.decide('orchestrator', 'create_invoice', INPUT, WRITE);
    ledger.decide('orchestrator', 'other_write', {}, WRITE);
    assert.equal(ledger.abortedTool, 'other_write');

    ledger.beginReentry();

    assert.equal(ledger.abortedTool, undefined);
    assert.deepEqual(ledger.decide('orchestrator', 'create_invoice', INPUT, WRITE), {
      action: 'replay',
      record: { kind: 'result', value: 'run1' },
    });
  });

  it('a re-entry records nothing: the first run stays the only source', () => {
    const ledger = new ToolReplayLedger();
    ledger.beginReentry();
    ledger.record('orchestrator', 'lookup', INPUT, { kind: 'result', value: 'fresh' });
    ledger.beginReentry();
    assert.deepEqual(ledger.decide('orchestrator', 'lookup', INPUT, READ), { action: 'execute' });
  });

  it('a thrown call replays as the same rejection', () => {
    const ledger = new ToolReplayLedger();
    const error = new Error('socket hang up');
    ledger.record('orchestrator', 'create_invoice', INPUT, { kind: 'rejection', error });
    ledger.beginReentry();
    const decision = ledger.decide('orchestrator', 'create_invoice', INPUT, WRITE);
    assert.equal(decision.action, 'replay');
    assert.equal(decision.action === 'replay' && decision.record.kind === 'rejection' && decision.record.error, error);
  });

  it('a read-only miss executes on a re-entry without aborting it', () => {
    const ledger = new ToolReplayLedger();
    ledger.beginReentry();
    assert.deepEqual(ledger.decide('orchestrator', 'memory', { command: 'view' }, READ), { action: 'execute' });
    assert.equal(ledger.abortedTool, undefined);
  });

  it('keys ignore key order and separate the seams', () => {
    const ledger = new ToolReplayLedger();
    ledger.record('orchestrator', 'create_invoice', { a: 1, b: { c: 2, d: 3 } }, { kind: 'result', value: 'x' });
    ledger.beginReentry();
    assert.equal(ledger.decide('subagent:crm', 'create_invoice', { a: 1, b: { c: 2, d: 3 } }, WRITE).action, 'refuse-miss');
    ledger.beginReentry();
    assert.equal(ledger.decide('orchestrator', 'create_invoice', { b: { d: 3, c: 2 }, a: 1 }, WRITE).action, 'replay');
  });

  it('a rerun entry executes again on a re-entry; an unreplayable one abandons it', () => {
    const ledger = new ToolReplayLedger();
    ledger.record('orchestrator', 'ask_crm', INPUT, { kind: 'rerun' });
    ledger.record('orchestrator', 'mcp_tool', INPUT, { kind: 'unreplayable' });
    ledger.beginReentry();
    assert.deepEqual(ledger.decide('orchestrator', 'ask_crm', INPUT, WRITE), { action: 'execute' });
    assert.equal(ledger.abortedTool, undefined);
    assert.deepEqual(ledger.decide('orchestrator', 'mcp_tool', INPUT, READ), { action: 'refuse-miss' });
    assert.equal(ledger.abortedTool, 'mcp_tool');
  });
});

describe('ToolReplayLedger — a call whose outcome is unknown is not repeated', () => {
  it('after a thrown write, an identical write is refused; another input and a read still run', () => {
    const ledger = new ToolReplayLedger({ retainResults: false });
    ledger.record('orchestrator', 'create_invoice', INPUT, { kind: 'rejection', error: new Error('x') });
    assert.deepEqual(ledger.decide('orchestrator', 'create_invoice', INPUT, WRITE), { action: 'refuse-repeat' });
    // Any seam: it is the same call on the same downstream system.
    assert.deepEqual(ledger.decide('dispatch', 'create_invoice', INPUT, WRITE), { action: 'refuse-repeat' });
    assert.deepEqual(ledger.decide('orchestrator', 'create_invoice', { ...INPUT, amount: 1 }, WRITE), { action: 'execute' });
    assert.deepEqual(ledger.decide('orchestrator', 'create_invoice', INPUT, READ), { action: 'execute' });
    assert.equal(ledger.abortedTool, undefined);
  });

  it('a call a wrapper reported as unknown counts the same', () => {
    const ledger = new ToolReplayLedger({ retainResults: false });
    ledger.noteUnknownOutcome('create_invoice', INPUT);
    assert.deepEqual(ledger.decide('subagent:crm', 'create_invoice', INPUT, WRITE), { action: 'refuse-repeat' });
  });

  it('on a re-entry the replayed rejection comes first, the repeat after it is refused, not a miss', () => {
    const ledger = new ToolReplayLedger();
    ledger.record('orchestrator', 'create_invoice', INPUT, { kind: 'rejection', error: new Error('x') });
    ledger.beginReentry();
    assert.equal(ledger.decide('orchestrator', 'create_invoice', INPUT, WRITE).action, 'replay');
    assert.deepEqual(ledger.decide('orchestrator', 'create_invoice', INPUT, WRITE), { action: 'refuse-repeat' });
    assert.equal(ledger.abortedTool, undefined);
  });

  it('without retained results a re-entry has nothing to replay', () => {
    const ledger = new ToolReplayLedger({ retainResults: false });
    ledger.record('orchestrator', 'create_invoice', INPUT, { kind: 'result', value: 'secret rows' });
    ledger.beginReentry();
    assert.deepEqual(ledger.decide('orchestrator', 'create_invoice', INPUT, WRITE), { action: 'refuse-miss' });
  });
});

describe('ToolReplayLedger — what a replayed tool attached', () => {
  const FILE = { kind: 'file', payload: { url: 'https://files.example/r.xlsx' } };
  const DIAGRAM = { kind: 'diagram', payload: { url: 'https://files.example/d.png' } };

  it('a pass gets back the first run’s attachments of the tools it replayed, once', () => {
    const ledger = new ToolReplayLedger();
    ledger.record('orchestrator', 'build_report', INPUT, { kind: 'result', value: 'ok' });
    ledger.recordAttachments('build_report', [FILE]);
    ledger.recordAttachments('render_diagram', [DIAGRAM]);

    ledger.beginReentry();
    assert.deepEqual(ledger.takeReplayedAttachments(), [], 'nothing replayed yet');
    ledger.decide('orchestrator', 'build_report', INPUT, WRITE);
    assert.deepEqual(ledger.takeReplayedAttachments(), [FILE], 'only the replayed tool');
    assert.deepEqual(ledger.takeReplayedAttachments(), [], 'once per pass');

    ledger.beginReentry();
    ledger.decide('orchestrator', 'build_report', INPUT, WRITE);
    assert.deepEqual(ledger.takeReplayedAttachments(), [FILE], 'again on the next re-entry');
  });

  it('keeps no attachments without retained results, nor from a re-entry', () => {
    const local = new ToolReplayLedger({ retainResults: false });
    local.recordAttachments('build_report', [FILE]);
    local.beginReentry();
    local.decide('orchestrator', 'build_report', INPUT, WRITE);
    assert.deepEqual(local.takeReplayedAttachments(), []);

    const ledger = new ToolReplayLedger();
    ledger.beginReentry();
    ledger.recordAttachments('build_report', [FILE]);
    assert.deepEqual(ledger.takeReplayedAttachments(), []);
  });
});

describe('the abort error and the miss notice', () => {
  it('name the tool and nothing else', () => {
    const err = new ToolReplayAbortError('create_invoice');
    assert.equal(err.toolName, 'create_invoice');
    assert.match(err.message, /create_invoice/);
    const notice = replayMissNotice('create`invoice <x>');
    assert.match(notice, /^Error: tool `createinvoicex` was not run/);
  });
});

const receipt = (over: Partial<PrivacyReceipt> = {}): PrivacyReceipt => ({
  datasetsInterned: 1,
  fieldsMasked: 2,
  fieldsCleartext: 3,
  verbsExecuted: ['filter'],
  pseudonymProjectionUsed: false,
  ...over,
});

describe('RequestReceipts — one receipt for one request', () => {
  it('a single pass is passed through unchanged', () => {
    const only = receipt({ verbsExecuted: ['filter', 'filter'] });
    assert.equal(mergePrivacyReceipts([only]), only);
  });

  it('several passes: counts are the largest pass, lists the union, flags any', () => {
    const bypass = { toolName: 'lookup', pluginId: 'p', reason: 'operator_setting' as const, bytes: 9 };
    const toolError = { toolName: 'create', carrier: 'thrown' as const, outcome: 'withheld' as const, bytes: 4 };
    const merged = mergePrivacyReceipts([
      receipt({ bypassedTools: [bypass], toolErrors: [toolError] }),
      receipt({ datasetsInterned: 2, verbsExecuted: ['filter', 'sum'], pseudonymProjectionUsed: true, toolErrors: [toolError] }),
    ]);
    assert.deepEqual(merged, {
      datasetsInterned: 2,
      fieldsMasked: 2,
      fieldsCleartext: 3,
      verbsExecuted: ['filter', 'sum'],
      pseudonymProjectionUsed: true,
      bypassedTools: [bypass],
      toolErrors: [toolError],
    });
  });

  it('commits the merged receipt once, through the first pass that offered to own the row', async () => {
    const rows: Array<[string, PrivacyReceipt]> = [];
    const owner = (rowId: string) => ({
      rowId,
      write: (r: PrivacyReceipt) => {
        rows.push([rowId, r]);
        return Promise.resolve();
      },
    });
    const receipts = new RequestReceipts();
    assert.equal(receipts.add(receipt(), owner('turn-1')), true);
    assert.equal(receipts.add(receipt({ datasetsInterned: 4 }), owner('turn-2')), false);
    assert.equal(receipts.rowId, 'turn-1');
    await receipts.commit();
    await receipts.commit();
    assert.deepEqual(rows, [['turn-1', receipt({ datasetsInterned: 4 })]]);
    assert.deepEqual(receipts.merged(), receipt({ datasetsInterned: 4 }));
  });

  it('without an owning pass nothing is written, and a failing write does not throw', async () => {
    const none = new RequestReceipts();
    none.add(receipt());
    await none.commit();
    assert.equal(none.rowId, undefined);
    const failing = new RequestReceipts();
    failing.add(receipt(), { rowId: 't', write: () => Promise.reject(new Error('db down')) });
    await failing.commit();
    assert.equal(new RequestReceipts().merged(), undefined);
  });
});
