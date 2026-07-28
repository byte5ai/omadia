/**
 * Epic #470 W0 — zero-dependency unified-diff parser + patch applier.
 *
 * No unified-diff utility exists in this repo, and pulling one in for a
 * security-critical path is the wrong trade: this module is small, pure, and
 * has no dependency that could ship a surprise. It serves two callers:
 *
 *   - `parseUnifiedDiff` returns per-file STATS. `diffApplyService` cross-checks
 *     these against the runner's uploaded `--numstat` so a runner cannot
 *     understate its own diff. W3's `DiffPolicyEngine` will read the same stats.
 *   - `parseUnifiedDiffDetailed` additionally returns hunks; `GithubForgeClient`
 *     applies them onto the pinned base blob to reconstruct committed content.
 *
 * It handles `diff --git` headers, quoted paths with spaces and C-style octal
 * unicode escapes, new/deleted/rename/copy markers, `Binary files … differ`,
 * hunk `+`/`-` counting (a `+++`/`---` line is a header, not an addition), CRLF,
 * and the `\ No newline at end of file` marker.
 */

export type DiffChange = 'add' | 'modify' | 'delete' | 'rename' | 'copy';

export interface DiffFileStat {
  path: string;
  oldPath?: string;
  change: DiffChange;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Raw body lines, each including its leading marker (' ', '+', '-', '\'). */
  lines: string[];
}

export interface DiffFileChange {
  path: string;
  oldPath?: string;
  change: DiffChange;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** Git mode the diff declares (`new file mode` / `new mode`); undefined if unchanged. */
  mode?: string;
}

/**
 * Base at the applied position does not match a `-`/context line the diff shows.
 *
 * The message carries no file content. `expected` and `actual` are lines from the
 * customer's repository and from an attacker-influenceable diff; this error's
 * message reaches `dev_jobs.error` and `dev_job_events` payloads, which are
 * rendered in the admin UI and streamed over SSE. A base line may be a secret.
 * The full lines stay on the error object for tests and for a debugger; anything
 * that persists or transmits this error must use `.message`, never the fields.
 */
export class DiffContextMismatchError extends Error {
  constructor(
    readonly path: string,
    readonly hunk: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`diff does not match the base at ${path} ${hunk}: a context or deletion line differs`);
    this.name = 'DiffContextMismatchError';
  }
}

/** A hunk body does not consume exactly the line counts its header declares. */
export class DiffStructureError extends Error {
  constructor(
    readonly path: string,
    readonly hunk: string,
    detail: string,
  ) {
    super(`malformed diff at ${path} ${hunk}: ${detail}`);
    this.name = 'DiffStructureError';
  }
}

/** Optional context so the applier can name the file in a mismatch error. */
export interface ApplyContext {
  path: string;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const C_ESCAPES: Record<string, number> = {
  n: 10,
  t: 9,
  r: 13,
  '"': 34,
  '\\': 92,
  a: 7,
  b: 8,
  f: 12,
  v: 11,
};

/** Per-file stats — the numstat cross-check surface. */
export function parseUnifiedDiff(diff: string): DiffFileStat[] {
  return parseUnifiedDiffDetailed(diff).map((f) => {
    const stat: DiffFileStat = {
      path: f.path,
      change: f.change,
      additions: f.additions,
      deletions: f.deletions,
      binary: f.binary,
    };
    if (f.oldPath !== undefined) stat.oldPath = f.oldPath;
    return stat;
  });
}

interface MutableFile {
  change: DiffChange;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  aPath?: string;
  bPath?: string;
  /** a-side from `--- `; null means /dev/null (an add). */
  minus?: string | null;
  /** b-side from `+++ `; null means /dev/null (a delete). */
  plus?: string | null;
  oldPath?: string;
  newPath?: string;
  mode?: string;
}

/** Full parse including hunks — the content-reconstruction surface. */
export function parseUnifiedDiffDetailed(diff: string): DiffFileChange[] {
  const lines = diff
    .split('\n')
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const files: DiffFileChange[] = [];
  let cur: MutableFile | null = null;

  const flush = () => {
    if (cur) files.push(finalizeFile(cur));
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (line.startsWith('diff --git ')) {
      flush();
      cur = { change: 'modify', binary: false, additions: 0, deletions: 0, hunks: [] };
      const pair = parseDiffGitPaths(line.slice('diff --git '.length));
      if (pair) {
        cur.aPath = pair[0];
        cur.bPath = pair[1];
      }
      continue;
    }
    if (!cur) continue;

    if (line.startsWith('new file mode')) {
      cur.change = 'add';
      cur.mode = lastToken(line);
    } else if (line.startsWith('new mode ')) {
      cur.mode = lastToken(line);
    } else if (line.startsWith('deleted file mode')) {
      cur.change = 'delete';
    } else if (line.startsWith('rename from ')) {
      cur.change = 'rename';
      cur.oldPath = unquotePath(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) {
      cur.change = 'rename';
      cur.newPath = unquotePath(line.slice('rename to '.length));
    } else if (line.startsWith('copy from ')) {
      cur.change = 'copy';
      cur.oldPath = unquotePath(line.slice('copy from '.length));
    } else if (line.startsWith('copy to ')) {
      cur.change = 'copy';
      cur.newPath = unquotePath(line.slice('copy to '.length));
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      cur.binary = true;
    } else if (line.startsWith('--- ')) {
      const p = line.slice(4);
      cur.minus = p === '/dev/null' ? null : stripAbPrefix(unquotePath(p));
    } else if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      cur.plus = p === '/dev/null' ? null : stripAbPrefix(unquotePath(p));
    } else {
      const m = HUNK_RE.exec(line);
      if (m) {
        i = consumeHunk(cur, lines, i, m);
      }
      // Anything else (index, mode, similarity) is ignored.
    }
  }
  flush();
  return files;
}

/**
 * Reconstruct new file content by applying hunks onto `base`, VERIFYING every
 * `-` and context line against the base first. `git apply` rejects a hunk whose
 * context/deletion lines do not match the target; so does this. Applying diffs
 * positionally without this check falsifies the epic's headline guarantee — the
 * committed tree would diverge from the diff a human reviewed. Fails closed with
 * a typed `DiffContextMismatchError` naming the file, hunk, expected, and actual.
 */
export function applyHunks(base: string, hunks: DiffHunk[], ctx?: ApplyContext): string {
  const path = ctx?.path ?? '(unknown)';
  const src = splitLines(base);
  const out: string[] = [];
  let cursor = 0;
  let noFinalNewline = false;
  let lastKind: '+' | '-' | ' ' | null = null;

  for (const hunk of hunks) {
    const header = formatHunkHeader(hunk);
    const start = hunk.oldStart <= 0 ? 0 : hunk.oldStart - 1;
    if (start > src.length) {
      throw new DiffContextMismatchError(
        path,
        header,
        `a line at position ${String(start + 1)}`,
        'end of file',
      );
    }
    while (cursor < start) out.push(src[cursor++] ?? '');
    for (const raw of hunk.lines) {
      const tag = raw.charAt(0);
      const text = raw.slice(1);
      if (tag === '+') {
        out.push(text);
        lastKind = '+';
      } else if (tag === '\\') {
        // `\ No newline at end of file` — refers to the previous line's side.
        if (lastKind === '+' || lastKind === ' ') noFinalNewline = true;
      } else {
        // Deletion (`-`) or context (` `): both MUST match the base at cursor.
        const actual = cursor < src.length ? (src[cursor] ?? '') : undefined;
        if (actual === undefined || actual !== text) {
          throw new DiffContextMismatchError(path, header, text, actual ?? 'end of file');
        }
        cursor++;
        if (tag === '-') {
          lastKind = '-';
        } else {
          out.push(actual);
          lastKind = ' ';
        }
      }
    }
  }
  while (cursor < src.length) out.push(src[cursor++] ?? '');
  if (out.length === 0) return '';
  return out.join('\n') + (noFinalNewline ? '' : '\n');
}

function formatHunkHeader(h: DiffHunk): string {
  return `@@ -${String(h.oldStart)},${String(h.oldLines)} +${String(h.newStart)},${String(
    h.newLines,
  )} @@`;
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

function consumeHunk(
  cur: MutableFile,
  lines: string[],
  headerIndex: number,
  m: RegExpExecArray,
): number {
  const oldLines = m[2] === undefined ? 1 : parseInt(m[2], 10);
  const newLines = m[4] === undefined ? 1 : parseInt(m[4], 10);
  const hunk: DiffHunk = {
    oldStart: parseInt(m[1] ?? '0', 10),
    oldLines,
    newStart: parseInt(m[3] ?? '0', 10),
    newLines,
    lines: [],
  };
  const path = cur.bPath ?? cur.newPath ?? cur.aPath ?? '(unknown)';
  const header = formatHunkHeader(hunk);
  let oldRem = oldLines;
  let newRem = newLines;
  let i = headerIndex;
  // The body MUST consume exactly the counts the header declares. A header that
  // under-counts its body lets the applied tree diverge from what numstat (and
  // W3's policy engine) reason over, so both under- and over-run fail closed.
  while (oldRem > 0 || newRem > 0) {
    const body = i + 1 < lines.length ? (lines[i + 1] ?? '') : undefined;
    // A truly-empty line ('') is never a legitimate body line — git emits a
    // single space for an empty context line — so it (like a header/EOF) marks
    // the body's end. Hitting it with counts unsatisfied is an under-run.
    if (
      body === undefined ||
      body === '' ||
      body.startsWith('diff --git ') ||
      HUNK_RE.test(body)
    ) {
      throw new DiffStructureError(path, header, 'hunk body ends before its declared line counts are satisfied');
    }
    i++;
    const c = body.charAt(0);
    if (c === '+') {
      cur.additions++;
      newRem--;
      hunk.lines.push(body);
    } else if (c === '-') {
      cur.deletions++;
      oldRem--;
      hunk.lines.push(body);
    } else if (c === '\\') {
      hunk.lines.push(body);
    } else {
      // A space-prefixed context line, or a bare empty line (empty context).
      oldRem--;
      newRem--;
      hunk.lines.push(body.length > 0 ? body : ' ');
    }
    if (oldRem < 0 || newRem < 0) {
      throw new DiffStructureError(path, header, 'hunk body has more +/- lines than its header declares');
    }
  }
  // Trailing `\ No newline at end of file` markers sit AFTER the last counted
  // line (both counts already 0), so pull them in here — applyHunks needs the
  // one that follows a `+`/context line to drop the new file's final newline.
  while (i + 1 < lines.length && (lines[i + 1] ?? '').startsWith('\\')) {
    i++;
    hunk.lines.push(lines[i] ?? '');
  }
  // A `+`/`-`/context line still sitting here means the header under-declared
  // its body — the surplus would otherwise be silently dropped by the caller.
  const surplus = i + 1 < lines.length ? (lines[i + 1] ?? '') : undefined;
  if (surplus !== undefined) {
    const sc = surplus.charAt(0);
    if (sc === '+' || sc === '-' || sc === ' ') {
      throw new DiffStructureError(path, header, 'hunk body has more lines than its header declares');
    }
  }
  cur.hunks.push(hunk);
  return i;
}

function finalizeFile(f: MutableFile): DiffFileChange {
  let path = f.newPath ?? (f.plus === null ? undefined : f.plus) ?? f.bPath ?? '';
  const oldPath = f.oldPath ?? (f.minus === null ? undefined : f.minus) ?? f.aPath;

  let change = f.change;
  if (f.plus === null) change = 'delete';
  else if (f.minus === null && change === 'modify') change = 'add';

  if (change === 'delete') path = oldPath ?? path;

  const result: DiffFileChange = {
    path,
    change,
    binary: f.binary,
    additions: f.additions,
    deletions: f.deletions,
    hunks: f.hunks,
  };
  if ((change === 'rename' || change === 'copy') && oldPath && oldPath !== path) {
    result.oldPath = oldPath;
  }
  if (f.mode !== undefined) result.mode = f.mode;
  return result;
}

function lastToken(line: string): string {
  const parts = line.trim().split(/\s+/);
  return parts[parts.length - 1] ?? '';
}

/** Parse the two paths off a `diff --git ` line (best-effort; markers win). */
function parseDiffGitPaths(rest: string): [string, string] | null {
  if (rest.startsWith('"')) {
    const first = readQuoted(rest, 0);
    if (!first) return null;
    let j = first.end;
    while (j < rest.length && rest.charAt(j) === ' ') j++;
    let second: string;
    if (rest.charAt(j) === '"') {
      const q = readQuoted(rest, j);
      if (!q) return null;
      second = q.value;
    } else {
      second = rest.slice(j);
    }
    return [stripAbPrefix(first.value), stripAbPrefix(second)];
  }
  const m = /^a\/(.+) b\/(.+)$/.exec(rest);
  if (m && m[1] !== undefined && m[2] !== undefined) return [m[1], m[2]];
  return null;
}

function stripAbPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Decode a git path token: strip a trailing tab field, C-unquote if quoted. */
function unquotePath(token: string): string {
  const t = token.split('\t')[0] ?? token;
  if (t.startsWith('"')) {
    const q = readQuoted(t, 0);
    if (q) return q.value;
  }
  return t;
}

/**
 * Read a `"…"` quoted C-string starting at `start`, decoding `\n \t \\ \"` and
 * octal escapes (git emits high bytes as `\NNN`, so decode to bytes then UTF-8).
 */
function readQuoted(s: string, start: number): { value: string; end: number } | null {
  const bytes: number[] = [];
  let i = start + 1;
  while (i < s.length) {
    const ch = s.charAt(i);
    if (ch === '"') return { value: Buffer.from(bytes).toString('utf8'), end: i + 1 };
    if (ch === '\\') {
      i++;
      const e = s.charAt(i);
      if (e === '') break;
      if (e >= '0' && e <= '7') {
        let oct = e;
        for (let k = 0; k < 2; k++) {
          const n = s.charAt(i + 1);
          if (n >= '0' && n <= '7' && n !== '') {
            oct += n;
            i++;
          } else break;
        }
        bytes.push(parseInt(oct, 8) & 0xff);
      } else {
        bytes.push(C_ESCAPES[e] ?? e.charCodeAt(0));
      }
      i++;
    } else {
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
      i++;
    }
  }
  return null;
}

function splitLines(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}
