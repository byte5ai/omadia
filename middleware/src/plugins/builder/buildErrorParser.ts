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

export function parseTscErrors(stderr: string): BuildError[] {
  const out: BuildError[] = [];
  const lines = stderr.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.replace(ANSI_RE, '');
    const head = HEAD_RE.exec(line);
    if (head) {
      const [, filePath, lineStr, colStr, code, message] = head;
      out.push({
        path: filePath ?? '',
        line: Number(lineStr),
        col: Number(colStr),
        code: code ?? 'TS0',
        message: (message ?? '').trim(),
      });
      continue;
    }
    // Continuation line: starts with whitespace (after ANSI strip) and we
    // have a previous error to fold into.
    if (/^\s+\S/.test(line) && out.length > 0) {
      const prev = out[out.length - 1]!;
      prev.message = `${prev.message}\n${line.trim()}`;
    }
  }

  return out;
}
