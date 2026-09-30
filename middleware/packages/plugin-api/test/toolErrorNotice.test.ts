/**
 * The withheld tool-error notice — what a model sees in place of an exception
 * message. The contract under test: the notice NEVER carries the exception
 * text, only the exception's class name, a sanitised error code and a log
 * reference an operator can grep for. Every producer that turns a caught
 * exception into a tool result (the kernel's dispatch seams and the in-tree
 * tool wrappers) builds it through these helpers, so a drift here reopens the
 * leak everywhere at once.
 *
 * All fixture values are synthetic.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  TOOL_ERROR_PREFIX,
  describeThrownError,
  isControlFlowToolResult,
  newToolErrorRef,
  toolErrorFromException,
  withheldToolErrorNotice,
} from '../src/index.js';

const EMAIL = 'erika.mustermann@example.com';
const IBAN = 'DE89370400440532013000';
const PII_MESSAGE = `Fault: Invalid field 'x' on record {"email":"${EMAIL}","iban":"${IBAN}"}`;

class PgLikeError extends Error {
  constructor(
    message: string,
    readonly code: unknown,
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}

describe('describeThrownError', () => {
  it('keeps the class name and a SQLSTATE-shaped code, never the message', () => {
    const d = describeThrownError(new PgLikeError(PII_MESSAGE, '22P02'));
    assert.deepEqual(d, { name: 'DatabaseError', code: '22P02' });
  });

  it('accepts a numeric code (XML-RPC fault codes are numbers)', () => {
    assert.deepEqual(describeThrownError(new PgLikeError('x', 2)), {
      name: 'DatabaseError',
      code: '2',
    });
  });

  it('reads `faultCode` when there is no `code`', () => {
    const err = Object.assign(new Error('fault'), { faultCode: 1 });
    assert.deepEqual(describeThrownError(err), { name: 'Error', code: '1' });
  });

  it('drops a name or code that is not a plain token (spaces, an e-mail, too long)', () => {
    const spaced = new PgLikeError('x', 'has spaces');
    spaced.name = 'Not A Class Name';
    assert.deepEqual(describeThrownError(spaced), { name: 'Error' });

    const mailed = new PgLikeError('x', EMAIL);
    mailed.name = EMAIL;
    assert.deepEqual(describeThrownError(mailed), { name: 'Error' });

    const long = new PgLikeError('x', 'C'.repeat(49));
    assert.deepEqual(describeThrownError(long), { name: 'DatabaseError' });
  });

  it('describes a non-Error throw without stringifying it', () => {
    assert.deepEqual(describeThrownError(PII_MESSAGE), { name: 'Error' });
    assert.deepEqual(describeThrownError({ email: EMAIL }), { name: 'Error' });
    assert.deepEqual(describeThrownError(undefined), { name: 'Error' });
  });

  it('ignores a non-finite or boolean code', () => {
    assert.deepEqual(describeThrownError(new PgLikeError('x', Number.NaN)), {
      name: 'DatabaseError',
    });
    assert.deepEqual(describeThrownError(new PgLikeError('x', true)), {
      name: 'DatabaseError',
    });
  });
});

describe('withheldToolErrorNotice', () => {
  it('names the tool, the class, the code and the ref — and nothing of the message', () => {
    const notice = withheldToolErrorNotice(
      'odoo_search_partner',
      new PgLikeError(PII_MESSAGE, '22P02'),
      'err_0a1b2c3d4e5f',
    );
    assert.ok(notice.startsWith(`${TOOL_ERROR_PREFIX} `), 'keeps the `Error:` convention');
    assert.ok(isControlFlowToolResult(notice), 'is control flow, so `is_error` stays derivable');
    assert.match(
      notice,
      /^Error: tool `odoo_search_partner` failed with DatabaseError \(code 22P02\) \[ref err_0a1b2c3d4e5f\]\. /,
    );
    assert.equal(notice.includes(EMAIL), false, 'the e-mail must not survive');
    assert.equal(notice.includes(IBAN), false, 'the IBAN must not survive');
    assert.equal(notice.includes('Invalid field'), false, 'no fragment of the message');
    assert.match(notice, /withheld/);
  });

  it('omits the code clause when there is no usable code', () => {
    const notice = withheldToolErrorNotice('web_search', new Error(PII_MESSAGE), 'err_1');
    assert.match(notice, /^Error: tool `web_search` failed with Error \[ref err_1\]\. /);
  });

  it('neutralises a tool name or ref that could break out of the notice', () => {
    const notice = withheldToolErrorNotice('evil`] tool\nname', new Error('x'), 'r e`f');
    assert.match(notice, /^Error: tool `eviltoolname` failed with Error \[ref ref\]\. /);
  });
});

describe('newToolErrorRef', () => {
  it('mints a fresh token that no C0 identity pattern can match', () => {
    const a = newToolErrorRef();
    const b = newToolErrorRef();
    assert.notEqual(a, b);
    // Starts with a letter and holds no separator: a word-boundary-anchored
    // phone / id-number pattern has nowhere to start inside it.
    assert.match(a, /^err_[0-9a-f]{12}$/);
  });
});

describe('toolErrorFromException', () => {
  it('logs the FULL error under the ref and returns only the notice', () => {
    const logged: Array<{ line: string; err: unknown }> = [];
    const err = new PgLikeError(PII_MESSAGE, '23505');
    const notice = toolErrorFromException('crm_lookup', err, {
      site: 'test-site',
      log: (line, e) => logged.push({ line, err: e }),
    });

    assert.equal(logged.length, 1, 'exactly one diagnostic line');
    const ref = /\[ref (err_[0-9a-f]{12})\]/.exec(notice)?.[1];
    assert.ok(ref, `the notice carries a fresh ref: ${notice}`);
    assert.ok(logged[0]!.line.includes(`ref=${ref}`), 'the log line carries the same ref');
    assert.ok(logged[0]!.line.startsWith('[test-site:crm_lookup]'));
    assert.equal(logged[0]!.err, err, 'the full error (message + stack) goes to the log');
    assert.equal(notice.includes(EMAIL), false);
  });

  it('uses a caller-supplied ref verbatim', () => {
    const notice = toolErrorFromException('crm_lookup', new Error('x'), {
      ref: 'turn42',
      log: null,
    });
    assert.match(notice, /\[ref turn42\]/);
  });
});
