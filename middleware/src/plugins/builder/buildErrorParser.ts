/**
 * Parses tsc stderr into structured BuildError records.
 *
 * tsc produces lines of the form:
 *   src/foo.ts(42,5): error TS2322: Type 'X' is not assignable to type 'Y'.
 * followed (sometimes) by indented continuation lines that elaborate:
 *      Type 'X' is missing the following properties from type 'Y': a, b
 *
 * We capture the head line via a strict anchored regex and fold any
 * indented follow-up lines into the previous error's message.
 *
 * #1739 — the sandbox parses stdout and stderr joined, and stderr may hold a
 * Node stack trace of the build script (indented `at …` frames,
 * `node:internal` frames, the `throw new Error(…)` source line, absolute
 * `file:///…/staging/…` paths). Those lines are never folded: any line that
 * is neither a head nor an indented tsc continuation ends the current error,
 * and runtime-trace lines are dropped outright.
 */

export interface BuildError {
  path: string;
  line: number;
  col: number;
  /** Numeric tsc code, prefixed `TS`. */
  code: string;
  message: string;
}

const HEAD_RE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;

// ANSI colour escape: ESC (0x1B) + `[` + digits/semicolons + `m`. Built
// dynamically to avoid baking a control char into the source (no-control-regex).
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Lines of a Node runtime stack trace, never part of a tsc diagnostic. */
const RUNTIME_TRACE_RES: readonly RegExp[] = [
  /^\s*at\s/,
  /node:internal/,
  /\bthrow\s+new\s+\w*Error\b/,
  /file:\/\//,
  /^\s*\^+\s*$/,
];

function isRuntimeTraceLine(line: string): boolean {
  return RUNTIME_TRACE_RES.some((re) => re.test(line));
}

export function parseTscErrors(stderr: string): BuildError[] {
  const out: BuildError[] = [];
  const lines = stderr.split(/\r?\n/);
  // The error that indented lines may still continue; reset by any line that
  // is not a tsc continuation, so stderr noise after tsc's stdout cannot
  // attach itself to the last diagnostic.
  let current: BuildError | undefined;

  for (const rawLine of lines) {
    const line = rawLine.replace(ANSI_RE, '');
    const head = HEAD_RE.exec(line);
    if (head) {
      const [, filePath, lineStr, colStr, code, message] = head;
      current = {
        path: filePath ?? '',
        line: Number(lineStr),
        col: Number(colStr),
        code: code ?? 'TS0',
        message: (message ?? '').trim(),
      };
      out.push(current);
      continue;
    }
    const isContinuation = /^\s+\S/.test(line) && !isRuntimeTraceLine(line);
    if (isContinuation && current) {
      current.message = `${current.message}\n${line.trim()}`;
      continue;
    }
    current = undefined;
  }

  return out;
}
