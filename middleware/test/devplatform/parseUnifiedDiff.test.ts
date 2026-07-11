import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  applyHunks,
  DiffContextMismatchError,
  DiffStructureError,
  parseUnifiedDiff,
  parseUnifiedDiffDetailed,
  type DiffFileStat,
} from '../../src/devplatform/policy/parseUnifiedDiff.js';

const lf = (lines: string[]) => lines.join('\n') + '\n';
const crlf = (lines: string[]) => lines.join('\r\n') + '\r\n';

const ADD = [
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  'index 0000000..e69de29',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,2 @@',
  '+hello',
  '+world',
];

const MODIFY_MULTI_HUNK = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' const c = 4;',
  '@@ -10,2 +10,3 @@',
  ' foo();',
  '+bar();',
  ' baz();',
];

const DELETE = [
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  'index abc1234..0000000',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-line1',
  '-line2',
];

const RENAME_PURE = [
  'diff --git a/old/name.txt b/new/name.txt',
  'similarity index 100%',
  'rename from old/name.txt',
  'rename to new/name.txt',
];

const RENAME_WITH_EDIT = [
  'diff --git a/a.txt b/b.txt',
  'similarity index 80%',
  'rename from a.txt',
  'rename to b.txt',
  'index 1111111..2222222 100644',
  '--- a/a.txt',
  '+++ b/b.txt',
  '@@ -1 +1 @@',
  '-old',
  '+new',
];

const COPY = [
  'diff --git a/src.txt b/copy.txt',
  'similarity index 100%',
  'copy from src.txt',
  'copy to copy.txt',
];

// File named "fä.txt" — git octal-escapes the UTF-8 bytes of ä (0xC3 0xA4).
const QUOTED_UNICODE = [
  'diff --git "a/f\\303\\244.txt" "b/f\\303\\244.txt"',
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  '+++ "b/f\\303\\244.txt"',
  '@@ -0,0 +1 @@',
  '+hi',
];

// "café menu.txt" — octal-escaped é (0xC3 0xA9) plus a literal space.
const QUOTED_UNICODE_SPACE = [
  'diff --git "a/caf\\303\\251 menu.txt" "b/caf\\303\\251 menu.txt"',
  'new file mode 100644',
  '--- /dev/null',
  '+++ "b/caf\\303\\251 menu.txt"',
  '@@ -0,0 +1 @@',
  '+x',
];

const BINARY = [
  'diff --git a/img.png b/img.png',
  'new file mode 100644',
  'index 0000000..1111111',
  'Binary files /dev/null and b/img.png differ',
];

const NO_NEWLINE = [
  'diff --git a/n.txt b/n.txt',
  'index 1111111..2222222 100644',
  '--- a/n.txt',
  '+++ b/n.txt',
  '@@ -1 +1 @@',
  '-old',
  '\\ No newline at end of file',
  '+new',
  '\\ No newline at end of file',
];

interface Case {
  name: string;
  diff: string;
  expect: DiffFileStat[];
}

const cases: Case[] = [
  {
    name: 'added file counts every + line',
    diff: lf(ADD),
    expect: [{ path: 'new.txt', change: 'add', additions: 2, deletions: 0, binary: false }],
  },
  {
    name: 'modify across multiple hunks; +++/--- headers are not additions',
    diff: lf(MODIFY_MULTI_HUNK),
    expect: [
      { path: 'src/app.ts', change: 'modify', additions: 2, deletions: 1, binary: false },
    ],
  },
  {
    name: 'deleted file counts every - line',
    diff: lf(DELETE),
    expect: [{ path: 'gone.txt', change: 'delete', additions: 0, deletions: 2, binary: false }],
  },
  {
    name: 'pure rename carries oldPath and zero counts',
    diff: lf(RENAME_PURE),
    expect: [
      {
        path: 'new/name.txt',
        oldPath: 'old/name.txt',
        change: 'rename',
        additions: 0,
        deletions: 0,
        binary: false,
      },
    ],
  },
  {
    name: 'rename with an edit keeps oldPath and counts the hunk',
    diff: lf(RENAME_WITH_EDIT),
    expect: [
      { path: 'b.txt', oldPath: 'a.txt', change: 'rename', additions: 1, deletions: 1, binary: false },
    ],
  },
  {
    name: 'copy carries oldPath',
    diff: lf(COPY),
    expect: [
      { path: 'copy.txt', oldPath: 'src.txt', change: 'copy', additions: 0, deletions: 0, binary: false },
    ],
  },
  {
    name: 'quoted path with octal unicode escapes decodes to UTF-8',
    diff: lf(QUOTED_UNICODE),
    expect: [{ path: 'fä.txt', change: 'add', additions: 1, deletions: 0, binary: false }],
  },
  {
    name: 'quoted path with unicode AND a space',
    diff: lf(QUOTED_UNICODE_SPACE),
    expect: [{ path: 'café menu.txt', change: 'add', additions: 1, deletions: 0, binary: false }],
  },
  {
    name: 'binary marker sets binary and skips line counting',
    diff: lf(BINARY),
    expect: [{ path: 'img.png', change: 'add', additions: 0, deletions: 0, binary: true }],
  },
  {
    name: 'CRLF line endings parse identically to LF',
    diff: crlf(MODIFY_MULTI_HUNK),
    expect: [
      { path: 'src/app.ts', change: 'modify', additions: 2, deletions: 1, binary: false },
    ],
  },
  {
    name: 'no-newline markers do not inflate counts',
    diff: lf(NO_NEWLINE),
    expect: [{ path: 'n.txt', change: 'modify', additions: 1, deletions: 1, binary: false }],
  },
];

describe('parseUnifiedDiff', () => {
  for (const c of cases) {
    it(c.name, () => {
      assert.deepEqual(parseUnifiedDiff(c.diff), c.expect);
    });
  }

  it('parses multiple files in one diff', () => {
    const stats = parseUnifiedDiff(lf([...ADD, ...DELETE]));
    assert.equal(stats.length, 2);
    assert.equal(stats[0]?.path, 'new.txt');
    assert.equal(stats[1]?.path, 'gone.txt');
  });

  it('returns an empty array for an empty diff', () => {
    assert.deepEqual(parseUnifiedDiff(''), []);
  });

  it('captures a declared executable / non-file mode', () => {
    const [file] = parseUnifiedDiffDetailed(
      lf([
        'diff --git a/run.sh b/run.sh',
        'new file mode 100755',
        '--- /dev/null',
        '+++ b/run.sh',
        '@@ -0,0 +1 @@',
        '+#!/bin/sh',
      ]),
    );
    assert.equal(file?.mode, '100755');
  });

  it('throws DiffStructureError when a hunk over-runs its declared count', () => {
    assert.throws(
      () =>
        parseUnifiedDiff(
          lf([
            'diff --git a/x.txt b/x.txt',
            'new file mode 100644',
            '--- /dev/null',
            '+++ b/x.txt',
            '@@ -0,0 +1,1 @@',
            '+one',
            '+two',
          ]),
        ),
      DiffStructureError,
    );
  });

  it('throws DiffStructureError when a hunk under-runs its declared count', () => {
    assert.throws(
      () =>
        parseUnifiedDiff(
          lf([
            'diff --git a/x.txt b/x.txt',
            '--- a/x.txt',
            '+++ b/x.txt',
            '@@ -1,3 +1,3 @@',
            ' a',
            '-b',
            '+B',
          ]),
        ),
      DiffStructureError,
    );
  });
});

describe('applyHunks', () => {
  const hunksOf = (lines: string[]) => parseUnifiedDiffDetailed(lf(lines))[0]?.hunks ?? [];

  it('reconstructs an added file from + lines with a trailing newline', () => {
    assert.equal(applyHunks('', hunksOf(ADD)), 'hello\nworld\n');
  });

  it('applies a single-line replacement onto base content', () => {
    const base = 'a\nb\nc\n';
    const hunks = hunksOf([
      'diff --git a/f.txt b/f.txt',
      'index 1..2 100644',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
    ]);
    assert.equal(applyHunks(base, hunks), 'a\nB\nc\n');
  });

  it('applies multiple hunks in order', () => {
    const base = 'const a = 1;\nconst b = 2;\nconst c = 4;\nx\ny\nz\np\nq\nr\nfoo();\nbaz();\n';
    const out = applyHunks(base, hunksOf(MODIFY_MULTI_HUNK));
    assert.match(out, /const b = 3;/);
    assert.match(out, /foo\(\);\nbar\(\);\nbaz\(\);/);
    assert.doesNotMatch(out, /const b = 2;/);
  });

  it('honors the no-newline-at-eof marker on the new side', () => {
    assert.equal(applyHunks('old\n', hunksOf(NO_NEWLINE)), 'new');
  });

  it('fails closed when a deletion line does not match the base', () => {
    const hunks = hunksOf([
      'diff --git a/f.txt b/f.txt',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-harmless',
      '+replaced',
      ' line3',
    ]);
    assert.throws(
      () => applyHunks('line1\nSECRET_CHECK()\nline3\n', hunks, { path: 'f.txt' }),
      (err: unknown) => {
        if (!(err instanceof DiffContextMismatchError)) return false;
        // The lines are on the error for a debugger and for this assertion...
        assert.equal(err.expected, 'harmless');
        assert.equal(err.actual, 'SECRET_CHECK()');
        // ...but never in the message. It reaches dev_jobs.error and event
        // payloads, which the admin UI renders and SSE streams; a base line
        // belongs to the customer's repository and may be a secret.
        assert.ok(!err.message.includes('SECRET_CHECK'));
        assert.ok(!err.message.includes('harmless'));
        return true;
      },
    );
  });

  it('fails closed when a context line does not match the base', () => {
    const hunks = hunksOf([
      'diff --git a/f.txt b/f.txt',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,2 +1,3 @@',
      ' expected-context',
      '+added',
      ' tail',
    ]);
    assert.throws(
      () => applyHunks('DIFFERENT\ntail\n', hunks, { path: 'f.txt' }),
      DiffContextMismatchError,
    );
  });
});
