import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  makeLimitSignal,
  formatLimitSignalNote,
  appendLimitSignalNote,
  type LimitSignal,
  type LocalSubAgentToolResult,
} from '../../packages/plugin-api/src/index.js';

describe('makeLimitSignal (Layer A)', () => {
  it('omits absent optional fields', () => {
    const s = makeLimitSignal('unsupported_operation', 'no $apply support');
    assert.deepEqual(s, { kind: 'unsupported_operation', detail: 'no $apply support' });
  });

  it('keeps provided fields (Dynamics row-cap example)', () => {
    const s: LimitSignal = makeLimitSignal('row_cap', '$top capped at 50', {
      cap: 50,
      observed: 8300,
      hint: 'use $apply aggregation',
    });
    assert.equal(s.cap, 50);
    assert.equal(s.observed, 8300);
    assert.equal(s.hint, 'use $apply aggregation');
  });
});

describe('LocalSubAgentToolResult.limitSignal (additive)', () => {
  it('accepts a tool result carrying a limit signal', () => {
    const r: LocalSubAgentToolResult = {
      output: 'returned 50 of 8300 rows',
      limitSignal: makeLimitSignal('row_cap', '$top capped at 50', { cap: 50, observed: 8300 }),
    };
    assert.equal(r.limitSignal?.kind, 'row_cap');
    // legacy bare result still type-checks
    const legacy: LocalSubAgentToolResult = { output: 'ok' };
    assert.equal(legacy.limitSignal, undefined);
  });
});

describe('formatLimitSignalNote / appendLimitSignalNote (orchestrator surfacing)', () => {
  it('returns empty for no signal and leaves output untouched', () => {
    assert.equal(formatLimitSignalNote(undefined), '');
    assert.equal(appendLimitSignalNote('rows…', undefined), 'rows…');
  });

  it('renders a machine-parseable, bounded note', () => {
    const note = formatLimitSignalNote(
      makeLimitSignal('row_cap', '$top capped at 50', { cap: 50, observed: 8300, hint: 'use $apply' }),
    );
    assert.match(note, /^\[tool-limit:row_cap\]/);
    assert.match(note, /cap=50, observed=8300/);
    assert.match(note, /Hint: use \$apply\./);
    assert.match(note, /INCOMPLETE/);
    assert.match(note, /request_self_extension/);
  });

  it('appends the note separated by a blank line', () => {
    const out = appendLimitSignalNote('50 of 8300 rows', makeLimitSignal('row_cap', 'capped', { cap: 50 }));
    assert.match(out, /^50 of 8300 rows\n\n\[tool-limit:row_cap\]/);
  });
});
