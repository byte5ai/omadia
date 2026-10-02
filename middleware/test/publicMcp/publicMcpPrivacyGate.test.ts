import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { PrivacyTurnHandle } from '@omadia/orchestrator';

import {
  createFailClosedPrivacyGate,
  MASKING_FAILED_PLACEHOLDER,
} from '../../src/mcp/publicMcpPrivacy.js';

/**
 * `createFailClosedPrivacyGate` — the handle for code NESTED inside a public
 * tool call (`forNestedCalls()`), which `ToolDispatchService` installs while a
 * handler runs, so a domain tool's sub-agent model loop is guarded too.
 *
 * Nested masking must protect the sub-agent's provider wire without standing in
 * for the masking of the call's own result: `masked()` is the endpoint's
 * positive signal that THE RESULT crossed the boundary, and a sub-agent having
 * masked its inner rows says nothing about the text it hands back.
 */

const EMAIL = 'jane.doe@customer.example';

function baseHandle(opts: {
  readonly internThrows?: boolean;
  readonly toolErrors?: unknown[];
}): PrivacyTurnHandle {
  return {
    async internToolResultV4({ rawResult }: { toolName: string; rawResult: string }) {
      if (opts.internThrows === true) throw new Error('provider unavailable');
      return { digestText: rawResult.replaceAll(EMAIL, '[email]'), datasetId: 'ds-1' };
    },
    checkBypass: () => ({ pluginId: '@omadia/agent-odoo-hr' }),
    async recordToolError(entry: unknown) {
      opts.toolErrors?.push(entry);
    },
    async redactToolErrorText({ text }: { text: string }) {
      return { outcome: 'redacted', text, spans: [], degraded: false };
    },
  } as unknown as PrivacyTurnHandle;
}

describe('public MCP privacy gate — the nested-call handle', () => {
  beforeEach(() => {
    mock.method(console, 'warn', () => {});
    mock.method(console, 'log', () => {});
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it('masks through the provider, but nested masking does not set masked()', async () => {
    const gate = createFailClosedPrivacyGate(baseHandle({}));
    const nested = gate.handle.forNestedCalls?.();
    assert.ok(nested, 'the gate must hand nested calls a handle of its own');

    const out = await nested.internToolResultV4({ toolName: 'hr_list', rawResult: `mail ${EMAIL}` });

    assert.equal(out.digestText, 'mail [email]');
    assert.equal(gate.masked(), false, 'a sub-agent masking its inner rows vouched for the outer result');
    assert.equal(gate.maskingFailed(), false);
  });

  it("control — masking the call's own result still sets masked()", async () => {
    const gate = createFailClosedPrivacyGate(baseHandle({}));

    await gate.handle.internToolResultV4({ toolName: 'ask_odoo_hr', rawResult: 'answer' });

    assert.equal(gate.masked(), true);
  });

  it('a nested masking failure fails the whole call closed', async () => {
    const gate = createFailClosedPrivacyGate(baseHandle({ internThrows: true }));
    const nested = gate.handle.forNestedCalls?.();

    const out = await nested?.internToolResultV4({ toolName: 'hr_list', rawResult: `mail ${EMAIL}` });

    assert.equal(out?.digestText, MASKING_FAILED_PLACEHOLDER, 'the sub-agent model would have seen raw rows');
    assert.equal(gate.maskingFailed(), true, 'the call must be discarded');
  });

  it('keeps the operator bypass off and serves no tool-error text', async () => {
    const toolErrors: unknown[] = [];
    const gate = createFailClosedPrivacyGate(baseHandle({ toolErrors }));
    const nested = gate.handle.forNestedCalls?.();

    assert.equal(nested?.checkBypass('hr_list'), undefined);
    const redacted = await nested?.redactToolErrorText({ toolName: 'mail_send', text: ` mailbox ${EMAIL}` });
    assert.equal(redacted?.outcome, 'withheld');
    await nested?.recordToolError({ toolName: 'mail_send', carrier: 'thrown', outcome: 'withheld', bytes: 9 });
    assert.deepEqual(toolErrors, [], 'a public request has no turn receipt to drain the entry');
  });

  it('is one handle per call, and stays nested further down', () => {
    const gate = createFailClosedPrivacyGate(baseHandle({}));
    const nested = gate.handle.forNestedCalls?.();
    assert.ok(nested);

    assert.equal(gate.handle.forNestedCalls?.(), nested);
    assert.equal(nested.forNestedCalls?.(), nested);
  });
});
