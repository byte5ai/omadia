/**
 * What a platform tool bridge hands the model when a bridged tool fails
 * (`bridgedToolError.ts`, used by `bridgePreviewTool` and `bridgeBuilderTool`).
 *
 * The contract: the model's own input failing the tool's schema comes back as
 * a readable hint it can correct its call from; an exception the tool's own
 * code threw comes back as the data-free withheld notice — never its text.
 * The stage decides, not the error's type: a Zod schema validating an
 * UPSTREAM response inside `run` reports upstream values.
 *
 * All values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { bridgedToolError } from '../../src/plugins/bridgedToolError.js';

const EMAIL = 'erika.mustermann@example.com';
const NAME = 'Erika Mustermann';
const THROWN = `Fault: Invalid field 'x' on record {"name":"${NAME}","email":"${EMAIL}"}`;

let errorCalls: unknown[][] = [];
beforeEach(() => {
  errorCalls = [];
  mock.method(console, 'error', (...args: unknown[]) => {
    errorCalls.push(args);
  });
});
afterEach(() => {
  mock.restoreAll();
});

function zodLikeError(issues: ReadonlyArray<{ path: unknown[]; message: string }>): Error {
  return Object.assign(new Error(JSON.stringify(issues)), { name: 'ZodError', issues });
}

describe('bridgedToolError', () => {
  it('turns an input-schema failure into a readable hint, not the ZodError JSON', () => {
    const out = bridgedToolError(
      'crm_search',
      zodLikeError([
        { path: ['query'], message: 'String must contain at least 1 character(s)' },
        { path: [], message: 'Required' },
      ]),
      'input',
      'test',
    );
    assert.equal(
      out,
      'Error: invalid input for `crm_search` — query: String must contain at least 1 character(s); <root>: Required',
    );
    assert.equal(out.includes('{'), false, 'no JSON dump the seams would withhold');
  });

  it('lists at most five issues and counts the rest', () => {
    const issues = Array.from({ length: 7 }, (_, i) => ({ path: [`f${String(i)}`], message: 'bad' }));
    const out = bridgedToolError('t', zodLikeError(issues), 'input', 'test');
    assert.match(out, /f4: bad \(\+2 more\)$/);
    assert.equal(out.includes('f5'), false);
  });

  it('withholds a run-stage exception — even a Zod error from an upstream schema', () => {
    const upstream = zodLikeError([
      { path: ['status'], message: `Invalid enum value. Expected 'open' | 'closed', received '${NAME}'` },
    ]);
    const out = bridgedToolError('crm_search', upstream, 'run', 'test');
    assert.equal(out.includes(NAME), false, `an upstream value reached the model: ${out}`);
    assert.match(out, /^Error: tool `crm_search` failed with ZodError \[ref err_[0-9a-f]{12}\]\. /);
    assert.equal(errorCalls.length, 1, 'the full error is logged');
    assert.equal(errorCalls[0]?.[1], upstream);
  });

  it('withholds an input-stage failure that is not a schema issue list', () => {
    const out = bridgedToolError('crm_search', new Error(THROWN), 'input', 'test');
    assert.equal(out.includes(EMAIL), false);
    assert.match(out, /^Error: tool `crm_search` failed with Error \[ref /);
  });

  it('keeps a tool id from breaking out of the backticks', () => {
    const out = bridgedToolError('evil`\nid', zodLikeError([{ path: ['a'], message: 'x' }]), 'input', 't');
    assert.match(out, /^Error: invalid input for `evilid` — a: x$/);
  });
});
