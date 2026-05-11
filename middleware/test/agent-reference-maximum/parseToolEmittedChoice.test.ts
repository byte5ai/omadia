import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseToolEmittedChoice } from '@omadia/orchestrator';

describe('parseToolEmittedChoice (OB-29-4)', () => {
  it('parses well-formed _pendingUserChoice payload', () => {
    const r = parseToolEmittedChoice(
      JSON.stringify({
        ok: true,
        _pendingUserChoice: {
          question: 'Welcher John?',
          rationale: 'mehrere Treffer',
          options: [
            { label: 'John Doe', value: 'note:n1' },
            { label: 'Jane Doe', value: 'note:n2' },
          ],
        },
      }),
    );
    assert.ok(r);
    assert.equal(r!.question, 'Welcher John?');
    assert.equal(r!.rationale, 'mehrere Treffer');
    assert.equal(r!.options.length, 2);
  });

  it('returns undefined for non-JSON content', () => {
    assert.equal(parseToolEmittedChoice('plain text'), undefined);
  });

  it('returns undefined when _pendingUserChoice key is absent', () => {
    assert.equal(
      parseToolEmittedChoice('{"ok":true,"matches":[]}'),
      undefined,
    );
  });

  it('returns undefined when question is empty', () => {
    assert.equal(
      parseToolEmittedChoice(
        JSON.stringify({
          _pendingUserChoice: {
            question: '',
            options: [{ label: 'a', value: 'a' }],
          },
        }),
      ),
      undefined,
    );
  });

  it('returns undefined when options array is empty', () => {
    assert.equal(
      parseToolEmittedChoice(
        JSON.stringify({
          _pendingUserChoice: {
            question: 'Q?',
            options: [],
          },
        }),
      ),
      undefined,
    );
  });

  it('skips malformed option entries', () => {
    const r = parseToolEmittedChoice(
      JSON.stringify({
        _pendingUserChoice: {
          question: 'Q?',
          options: [
            { label: 'good', value: 'a' },
            { label: 42 }, // missing value, wrong label type
            { label: 'also good', value: 'b' },
          ],
        },
      }),
    );
    assert.ok(r);
    assert.equal(r!.options.length, 2);
    assert.equal(r!.options[0]!.value, 'a');
    assert.equal(r!.options[1]!.value, 'b');
  });

  it('returns undefined when ALL option entries are malformed', () => {
    assert.equal(
      parseToolEmittedChoice(
        JSON.stringify({
          _pendingUserChoice: {
            question: 'Q?',
            options: [{ label: 42 }, { foo: 'bar' }],
          },
        }),
      ),
      undefined,
    );
  });

  it('omits rationale when not a string', () => {
    const r = parseToolEmittedChoice(
      JSON.stringify({
        _pendingUserChoice: {
          question: 'Q?',
          rationale: 42,
          options: [{ label: 'a', value: 'a' }],
        },
      }),
    );
    assert.ok(r);
    assert.equal(r!.rationale, undefined);
  });
});
