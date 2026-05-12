#!/usr/bin/env node
/**
 * CI bitrot check for the pattern table in
 * `middleware/packages/agent-reference-maximum/INTEGRATION.md` (OB-29-0..5).
 *
 * Validates: each `**Datei**: \`<path>:<line>?\`` line points to an
 * existing file. If a line number is given, the script verifies that it
 * is not outside the file (tracking against drift during refactors).
 *
 * Intentionally NOT checked (too brittle a sub-pattern):
 *   - Content of the referenced line
 *   - HTML comment marker `<!-- ETAPPE-N: ... -->` (placeholders for
 *     follow-up stages — should not fail the check)
 *
 * Invocation: `node middleware/scripts/check-integration-md.mjs`
 * Exit 0 = ok, Exit 1 = drift detected.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INTEGRATION_MD_PATH = path.resolve(
  HERE,
  '..',
  'packages',
  'agent-reference-maximum',
  'INTEGRATION.md',
);
const PACKAGE_ROOT = path.dirname(INTEGRATION_MD_PATH);

const FILE_REF_RE =
  /\*\*Datei\*\*:\s*((?:`[^`]+`(?:\s*\+\s*)?)+)/g;
const SINGLE_REF_RE = /`([^`]+)`/g;

function parseRef(raw) {
  // raw shape: "foo.ts:42" or "foo/bar.ts" (no line)
  const trimmed = raw.trim();
  const colon = trimmed.lastIndexOf(':');
  if (colon === -1) {
    return { file: trimmed, line: null };
  }
  const tail = trimmed.slice(colon + 1);
  if (!/^\d+$/.test(tail)) {
    return { file: trimmed, line: null };
  }
  return { file: trimmed.slice(0, colon), line: Number(tail) };
}

async function checkRef({ file, line }) {
  const abs = path.resolve(PACKAGE_ROOT, file);
  let stats;
  try {
    stats = await stat(abs);
  } catch {
    return { ok: false, reason: `not found: ${file}` };
  }
  if (!stats.isFile()) {
    return { ok: false, reason: `not a regular file: ${file}` };
  }
  if (line === null) return { ok: true };
  const text = await readFile(abs, 'utf8');
  const lineCount = text.split('\n').length;
  if (line < 1 || line > lineCount) {
    return {
      ok: false,
      reason: `line ${line} out of range (file has ${lineCount} lines): ${file}`,
    };
  }
  return { ok: true };
}

async function main() {
  const md = await readFile(INTEGRATION_MD_PATH, 'utf8');
  const errors = [];

  let blockMatch;
  FILE_REF_RE.lastIndex = 0;
  while ((blockMatch = FILE_REF_RE.exec(md)) !== null) {
    const block = blockMatch[1];
    const refs = [];
    let m;
    SINGLE_REF_RE.lastIndex = 0;
    while ((m = SINGLE_REF_RE.exec(block)) !== null) {
      refs.push(m[1]);
    }
    for (const raw of refs) {
      const parsed = parseRef(raw);
      const r = await checkRef(parsed);
      if (!r.ok) errors.push(`drift: ${r.reason}`);
    }
  }

  if (errors.length > 0) {
    console.error('INTEGRATION.md bitrot check FAILED:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('INTEGRATION.md bitrot check OK');
}

main().catch((err) => {
  console.error('check-integration-md crashed:', err);
  process.exit(1);
});
