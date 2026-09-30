/**
 * The one ingestion helper every tool-dispatch seam routes a tool error
 * through before a model reads it (`toolErrorRedaction.ts`).
 *
 * Two carriers, two policies:
 *  - a THROWN exception's message is withheld: the model gets the class name,
 *    a sanitised code and a log reference; the full error goes to the log;
 *  - a RETURNED `Error:` text is run through the privacy provider's free-text
 *    redactor, unless it is exception-shaped (a row dump, a stack trace) or
 *    too long to check, in which case it is withheld too. A provider that
 *    cannot redact makes the seam fail CLOSED.
 * The MCP connect prompt passes byte-identical. Every handled error is
 * receipted.
 *
 * Imported from SOURCE, not the `@omadia/orchestrator` barrel (which resolves
 * to `dist/`), so a change in `src/` cannot hide behind a stale build.
 * All values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { format, inspect } from 'node:util';

import type {
  PrivacyToolErrorRedactResult,
  PrivacyToolErrorRequest,
} from '@omadia/plugin-api';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import { createPrivacyTurnHandle } from '../../packages/harness-orchestrator/src/privacyHandle.js';
import type { PrivacyTurnHandle } from '../../packages/harness-orchestrator/src/privacyHandle.js';
import {
  MAX_REDACTABLE_TOOL_ERROR_CHARS,
  guardControlFlowResult,
  looksExceptionShaped,
  resetToolErrorRedactionDiagnostics,
  thrownToolErrorForModel,
  withholdThrownToolError,
} from '../../packages/harness-orchestrator/src/toolErrorRedaction.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';

const EMAIL = 'erika.mustermann@example.com';
const IBAN = 'DE89370400440532013000';
const AUTH_PROMPT =
  '🔒 The MCP server "Strava" needs authorization before it can be used. Ask the ' +
  "user to click Connect (this opens the provider's login), then retry: " +
  'https://example.test/oauth/authorize?state=0171234567&x=1\n' +
  '<mcp-auth-required serverId="s-1" server="Strava" needsClient="false"></mcp-auth-required>';

type RecordedEntry = Omit<PrivacyToolErrorRequest, 'turnId'>;

interface FakeHandleOptions {
  readonly redact?: (text: string) => PrivacyToolErrorRedactResult | undefined;
  readonly redactThrows?: boolean;
  readonly recordThrows?: boolean;
}

/** Only the two members the helper touches are real; the rest must never run. */
function fakeHandle(
  recorded: RecordedEntry[],
  redactCalls: string[],
  options: FakeHandleOptions = {},
): PrivacyTurnHandle {
  return {
    async recordToolError(entry: RecordedEntry) {
      if (options.recordThrows === true) throw new Error('receipt store down');
      recorded.push(entry);
    },
    async redactToolErrorText({ text }: { toolName: string; text: string }) {
      redactCalls.push(text);
      if (options.redactThrows === true) throw new Error('redactor crashed');
      if (options.redact) return options.redact(text);
      return {
        outcome: 'redacted',
        text: text.replaceAll(EMAIL, '[masked:email]').replaceAll(IBAN, '[masked:iban]'),
        spans: [
          ...(text.includes(EMAIL) ? [{ type: 'email', detector: 'c0-regex' }] : []),
          ...(text.includes(IBAN) ? [{ type: 'iban', detector: 'c0-regex' }] : []),
        ],
        degraded: false,
      };
    },
  } as unknown as PrivacyTurnHandle;
}

/** Like `console.error` itself, never throws on a value `String()` rejects. */
function printable(value: unknown): string {
  if (value instanceof Error) return value.message;
  try {
    return String(value);
  } catch {
    return '<unprintable>';
  }
}

let errorLines: string[] = [];
beforeEach(() => {
  errorLines = [];
  mock.method(console, 'error', (...args: unknown[]) => {
    errorLines.push(args.map(printable).join(' '));
  });
  mock.method(console, 'warn', () => {});
  resetToolErrorRedactionDiagnostics();
});
afterEach(() => {
  mock.restoreAll();
});

describe('thrownToolErrorForModel', () => {
  it('never contains the message, keeps the prefix, class name, code and ref', () => {
    const err = Object.assign(new Error(`duplicate key: (email)=(${EMAIL})`), {
      name: 'DatabaseError',
      code: '23505',
    });
    const notice = thrownToolErrorForModel('crm_upsert', err, 'turn-ref-1');
    assert.match(
      notice,
      /^Error: tool `crm_upsert` failed with DatabaseError \(code 23505\) \[ref turn-ref-1\]\. /,
    );
    assert.equal(notice.includes(EMAIL), false);
    assert.equal(notice.includes('duplicate key'), false);
  });

  it('drops a class name or code that is not a plain token', () => {
    const err = Object.assign(new Error('x'), { name: EMAIL, code: 'has spaces' });
    assert.match(thrownToolErrorForModel('t', err, 'r'), /failed with Error \[ref r\]/);
  });
});

describe('looksExceptionShaped', () => {
  it('flags row dumps, stack traces and driver detail lines', () => {
    for (const text of [
      ` Fault on record {"email":"${EMAIL}"}`,
      " Invalid field 'x' on record {'id': 42, 'name': 'Erika Mustermann'}",
      ' failed: [{"code":"invalid_type","path":["name"]}]',
      ' boom\n    at Object.handler (/srv/app/tool.js:12:7)',
      ' Traceback (most recent call last):\n  File "/srv/odoo/models.py", line 42, in write',
      ' duplicate key value violates unique constraint "users_email_key" Key (email)=(x) already exists',
    ]) {
      assert.equal(looksExceptionShaped(text), true, text);
    }
  });

  it('flags a JavaScript record the way util.inspect, console.log and %o print it', () => {
    class Partner {}
    const record = { id: 42, active: true, name: 'Jane Doe', email: EMAIL };
    for (const text of [
      ` Fault on record { name: 'Jane Doe', email: '${EMAIL}' }`,
      ` Fault on record ${inspect(record)}`, // multi-line
      format(' Fault on record %o', record),
      ` Fault on record ${inspect({ active: true, name: 'Jane Doe' })}`, // first value opens nothing
      ` Fault on ${inspect(Object.assign(new Partner(), record))}`,
      ` Fault on ${inspect(new Map(Object.entries(record)))}`, // 'name' => 'Jane Doe'
      ` Fault on records ${inspect([record])}`,
      ` Fault on ${inspect({ name: "Jane O'Doe" })}`, // double-quoted
      ` Fault on ${inspect({ name: 'Jane "JD" O\'Doe' })}`, // backtick-quoted
    ]) {
      assert.equal(looksExceptionShaped(text), true, text);
    }
  });

  it('leaves ordinary hints alone', () => {
    for (const text of [
      ' session_summary requires `scope`.',
      ' embeddings not configured — use `search_turns` for keyword-based search instead.',
      " unknown_filter_column — filter references unknown column 'Umsatz'.",
      ' no free slot on 2026-10-01 between 09:00 and 17:00.',
      ' tool `x` failed with DatabaseError (code 22P02) [ref err_0a1b2c3d4e5f].',
      ' link_key_filter — column "__k_name" is a link key.',
      ' expected { query: string, limit?: number } — got a string.',
      " invalid date, expected: '2026-10-01'.",
      ' could not reach http://[fd12:3456::1]:8080/mcp — connection refused.',
      " unknown placeholder {customer} in template '{amount:.2f}'.",
    ]) {
      assert.equal(looksExceptionShaped(text), false, text);
    }
  });
});

describe('guardControlFlowResult — returned `Error:` text', () => {
  it('redacts through the provider and keeps the hint and the prefix', async () => {
    const recorded: RecordedEntry[] = [];
    const calls: string[] = [];
    const out = await guardControlFlowResult({
      toolName: 'mail_send',
      result: `Error: mailbox ${EMAIL} is over quota; refund to ${IBAN} was not attempted`,
      privacy: fakeHandle(recorded, calls),
      site: 'test',
    });
    assert.equal(
      out,
      'Error: mailbox [masked:email] is over quota; refund to [masked:iban] was not attempted',
    );
    assert.deepEqual(calls, [` mailbox ${EMAIL} is over quota; refund to ${IBAN} was not attempted`]);
    assert.deepEqual(recorded, [
      {
        toolName: 'mail_send',
        carrier: 'returned',
        outcome: 'redacted',
        bytes: Buffer.byteLength(
          `Error: mailbox ${EMAIL} is over quota; refund to ${IBAN} was not attempted`,
        ),
        redactedSpans: [
          { type: 'email', detector: 'c0-regex' },
          { type: 'iban', detector: 'c0-regex' },
        ],
      },
    ]);
  });

  it('re-adds the `Error:` prefix even if a detector swallowed part of it', async () => {
    const out = await guardControlFlowResult({
      toolName: 't',
      result: 'Error: Error-prone input rejected',
      privacy: fakeHandle([], [], {
        redact: () => ({ outcome: 'redacted', text: ' [masked:custom] input rejected', spans: [], degraded: false }),
      }),
      site: 'test',
    });
    assert.equal(out, 'Error: [masked:custom] input rejected');
  });

  it('WITHHOLDS an exception-shaped text whole — the redactor is not even asked', async () => {
    const recorded: RecordedEntry[] = [];
    const calls: string[] = [];
    const result = `Error: Fault on record {"email":"${EMAIL}","iban":"${IBAN}"}`;
    const out = await guardControlFlowResult({
      toolName: 'odoo_write',
      result,
      privacy: fakeHandle(recorded, calls),
      site: 'test',
    });
    assert.equal(out.includes(EMAIL), false);
    assert.equal(out.includes(IBAN), false);
    assert.match(out, /^Error: tool `odoo_write` reported an error whose text looked like a raw/);
    assert.deepEqual(calls, []);
    assert.deepEqual(recorded, [
      { toolName: 'odoo_write', carrier: 'returned', outcome: 'withheld', bytes: Buffer.byteLength(result) },
    ]);
    const ref = /\[ref ([^\]]+)\]/.exec(out)?.[1];
    assert.ok(ref && errorLines.some((l) => l.includes(`ref=${ref}`) && l.includes(EMAIL)),
      'the original text is in the server log under the same ref');
  });

  it('WITHHOLDS a util.inspect / %o record echo that the real provider would half-mask', async () => {
    const privacy = createPrivacyTurnHandle({
      service: createPrivacyGuardService(),
      sessionId: 's-inspect',
      turnId: 't-inspect',
    });
    const body = ` Fault on record { name: 'Jane Doe', email: '${EMAIL}' }`;
    // Premise: C0 masks the e-mail but sees no name, so redaction would leak it.
    const alone = await privacy.redactToolErrorText({ toolName: 'odoo_write', text: body });
    assert.ok(alone?.outcome === 'redacted' && alone.text.includes('Jane Doe'), 'premise');
    const record = { id: 42, name: 'Jane Doe', email: EMAIL };
    for (const result of [`Error:${body}`, format('Error: Fault on record %o', record)]) {
      const out = await guardControlFlowResult({ toolName: 'odoo_write', result, privacy, site: 'test' });
      assert.equal(out.includes('Jane Doe'), false, out);
      assert.equal(out.includes(EMAIL), false, out);
      assert.match(out, /^Error: tool `odoo_write` reported an error whose text looked like a raw/);
    }
    const receipt = await privacy.finalize();
    assert.deepEqual(
      receipt?.toolErrors?.map((e) => [e.carrier, e.outcome]),
      [['returned', 'withheld'], ['returned', 'withheld']],
    );
  });

  it('withholds a text too long to check', async () => {
    const recorded: RecordedEntry[] = [];
    const out = await guardControlFlowResult({
      toolName: 'remote',
      result: `Error: ${'a '.repeat(MAX_REDACTABLE_TOOL_ERROR_CHARS)}`,
      privacy: fakeHandle(recorded, []),
      site: 'test',
    });
    assert.match(out, /was too long to check/);
    assert.equal(recorded[0]?.outcome, 'withheld');
  });

  it('fails CLOSED when the provider predates redaction, naming the version, logging once', async () => {
    const recorded: RecordedEntry[] = [];
    const handle = fakeHandle(recorded, [], { redact: () => undefined });
    const first = await guardControlFlowResult({
      toolName: 'crm',
      result: `Error: mailbox ${EMAIL} is over quota`,
      privacy: handle,
      site: 'test',
    });
    await guardControlFlowResult({
      toolName: 'crm',
      result: 'Error: another one',
      privacy: handle,
      site: 'test',
    });
    assert.equal(first.includes(EMAIL), false);
    assert.match(first, /@omadia\/plugin-privacy-guard >= 0\.6\.0/);
    assert.equal(recorded.length, 2);
    assert.ok(recorded.every((e) => e.outcome === 'withheld' && e.carrier === 'returned'));
    assert.equal(
      errorLines.filter((l) => l.includes('does not implement redactToolErrorText')).length,
      1,
      'the provider gap is logged once per process, not per call',
    );
  });

  it('fails CLOSED for a stub handle that lacks the member entirely', async () => {
    const out = await guardControlFlowResult({
      toolName: 'crm',
      result: `Error: mailbox ${EMAIL} is over quota`,
      privacy: {} as unknown as PrivacyTurnHandle,
      site: 'test',
    });
    assert.equal(out.includes(EMAIL), false);
    assert.match(out, /^Error: tool `crm` reported an error/);
  });

  it('fails CLOSED when the redactor throws or answers `withheld`', async () => {
    for (const options of [
      { redactThrows: true },
      { redact: () => ({ outcome: 'withheld', reason: 'residual' }) as const },
    ] satisfies FakeHandleOptions[]) {
      const recorded: RecordedEntry[] = [];
      const out = await guardControlFlowResult({
        toolName: 'crm',
        result: `Error: mailbox ${EMAIL} is over quota`,
        privacy: fakeHandle(recorded, [], options),
        site: 'test',
      });
      assert.equal(out.includes(EMAIL), false);
      assert.match(out, /could not be checked for personal data/);
      assert.equal(recorded[0]?.outcome, 'withheld');
    }
  });

  it('fails CLOSED on a malformed redaction answer instead of throwing', async () => {
    const recorded: RecordedEntry[] = [];
    const out = await guardControlFlowResult({
      toolName: 'crm',
      result: `Error: mailbox ${EMAIL} is over quota`,
      privacy: fakeHandle(recorded, [], {
        redact: () => ({ outcome: 'redacted' }) as unknown as PrivacyToolErrorRedactResult,
      }),
      site: 'test',
    });
    assert.equal(out.includes(EMAIL), false);
    assert.match(out, /could not be checked for personal data/);
    assert.equal(recorded[0]?.outcome, 'withheld');
  });

  it('never fails the dispatch because the receipt write failed', async () => {
    const out = await guardControlFlowResult({
      toolName: 'crm',
      result: `Error: mailbox ${EMAIL} is over quota`,
      privacy: fakeHandle([], [], { recordThrows: true }),
      site: 'test',
    });
    assert.equal(out, 'Error: mailbox [masked:email] is over quota');
  });
});

describe('guardControlFlowResult — MCP connect prompt', () => {
  it('passes byte-identical (URL digits untouched) and is receipted', async () => {
    const recorded: RecordedEntry[] = [];
    const calls: string[] = [];
    const out = await guardControlFlowResult({
      toolName: 'mcp__Strava__list_activities',
      result: AUTH_PROMPT,
      privacy: fakeHandle(recorded, calls),
      site: 'test',
    });
    assert.equal(out, AUTH_PROMPT);
    assert.deepEqual(calls, [], 'the prompt is kernel-authored; no redaction pass');
    assert.deepEqual(recorded, [
      {
        toolName: 'mcp__Strava__list_activities',
        carrier: 'mcp_auth_prompt',
        outcome: 'passed',
        bytes: Buffer.byteLength(AUTH_PROMPT),
      },
    ]);
  });
});

describe('withholdThrownToolError', () => {
  const err = new Error(`Fault on record {"email":"${EMAIL}"}`);

  it('withholds under a privacy handle, logs the full error, records the entry', async () => {
    const recorded: RecordedEntry[] = [];
    const out = await withholdThrownToolError({
      toolName: 'odoo_search_partner',
      err,
      privacy: fakeHandle(recorded, []),
      site: 'test',
      ref: 'r-1',
    });
    assert.equal(out.withheld, true);
    assert.equal(out.text, thrownToolErrorForModel('odoo_search_partner', err, 'r-1'));
    assert.equal(out.text.includes(EMAIL), false);
    assert.deepEqual(recorded, [
      {
        toolName: 'odoo_search_partner',
        carrier: 'thrown',
        outcome: 'withheld',
        bytes: Buffer.byteLength(err.message),
      },
    ]);
    assert.ok(errorLines.some((l) => l.includes('tool threw (ref=r-1)') && l.includes(EMAIL)));
  });

  it('uses the turn id as the ref inside a turn', async () => {
    const out = await turnContext.run({ turnId: 'turn-42', turnDate: '2026-09-30' }, () =>
      withholdThrownToolError({
        toolName: 't',
        err,
        privacy: fakeHandle([], []),
        site: 'test',
      }),
    );
    assert.match(out.text, /\[ref turn-42\]/);
  });

  it('keeps the raw message for an intern-exempt self tool (the agent\'s own state)', async () => {
    const recorded: RecordedEntry[] = [];
    const out = await withholdThrownToolError({
      toolName: 'memory',
      err,
      privacy: fakeHandle(recorded, []),
      site: 'test',
    });
    assert.deepEqual(out, { text: `Error: ${err.message}`, withheld: false });
    assert.deepEqual(recorded, []);
  });

  it('keeps the raw message without a privacy provider (parity), formatted by the caller', async () => {
    const plain = await withholdThrownToolError({ toolName: 't', err, privacy: undefined, site: 'test' });
    assert.deepEqual(plain, { text: `Error: ${err.message}`, withheld: false });
    const raw = await withholdThrownToolError({
      toolName: 't',
      err,
      privacy: undefined,
      site: 'test',
      formatRaw: (m) => m,
    });
    assert.equal(raw.text, err.message);
  });

  it('never throws for a thrown value String() cannot convert', async () => {
    const unprintable = Object.create(null) as object;
    const withheld = await withholdThrownToolError({
      toolName: 't',
      err: unprintable,
      privacy: fakeHandle([], []),
      site: 'test',
      ref: 'r',
    });
    assert.match(withheld.text, /^Error: tool `t` failed with Error \[ref r\]/);
    const parity = await withholdThrownToolError({
      toolName: 't',
      err: unprintable,
      privacy: undefined,
      site: 'test',
    });
    assert.equal(parity.text, 'Error: [unprintable thrown value]');
  });

  it('describes a non-Error throw without stringifying it into the notice', async () => {
    const out = await withholdThrownToolError({
      toolName: 't',
      err: `raw string with ${EMAIL}`,
      privacy: fakeHandle([], []),
      site: 'test',
      ref: 'r',
    });
    assert.equal(out.text.includes(EMAIL), false);
    assert.match(out.text, /failed with Error \[ref r\]/);
  });
});
