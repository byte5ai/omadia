#!/usr/bin/env node
/**
 * Issue #687 / category I3 — find user-facing string literals in `app/**`.
 *
 * #601 estimated this category with `grep` and reported 87 hits, of which only
 * 44 were real translations. The other 43 were JSON-Schema keywords, API enum
 * values, format-illustrating placeholders and type-signature noise — strings
 * that a translator MUST NOT touch. Feeding that list to a translation pass is
 * how you get `"Zeichenkette"` where the API expects `"string"`.
 *
 * So this scan does two things `grep` cannot:
 *
 *  1. It parses TSX with the TypeScript compiler and collects only JSX text
 *     nodes and the string-valued props a user actually reads. A `t('key')`
 *     argument, an import path or a `className` never enters the list, because
 *     they are never in those syntactic positions.
 *  2. It assigns every hit a REASON CODE, using the same vocabulary as
 *     `messages/GLOSSARY.md` and `scripts/i18n-identical-allowlist.json`.
 *     Only `translate` is work; the rest is documented non-work.
 *
 * This is a report, not a gate: it always exits 0. The gate is the per-file
 * ratchet in `app/_lib/i18n-structural.test.ts` — a file is added to its list
 * once it is clean, so the category cannot silently grow back.
 *
 * Usage:
 *   node scripts/i18n-literal-scan.mjs                 # summary + per-file counts
 *   node scripts/i18n-literal-scan.mjs --reason translate   # only real work
 *   node scripts/i18n-literal-scan.mjs --file admin/usage/page.tsx
 *   node scripts/i18n-literal-scan.mjs --json          # machine-readable
 */
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..', 'app');

/**
 * Props whose string value is rendered to, or read aloud to, a human. Kept
 * closed on purpose: an open list ("any prop ending in `label`") re-imports the
 * false-positive problem this script exists to remove.
 */
const USER_FACING_PROPS = new Set([
  'alt',
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'confirmLabel',
  'description',
  'emptyMessage',
  'error',
  'heading',
  'hint',
  'label',
  'message',
  'placeholder',
  'subtitle',
  'title',
  'tooltip',
]);

/**
 * JSON-Schema and TypeScript vocabulary. These appear in the schema editors and
 * the tool-parameter tables, where they name the type the API will accept.
 * Translating them changes what the user believes they may type.
 */
const SPEC_KEYWORDS = new Set([
  'any', 'array', 'boolean', 'const', 'enum', 'false', 'float', 'int',
  'integer', 'null', 'number', 'object', 'string', 'true', 'undefined',
  'unknown', 'void', 'anyOf', 'oneOf', 'allOf', 'items', 'properties',
  'required', 'additionalProperties', 'json', 'yaml', 'text', 'markdown',
]);

/** Product nouns from `messages/GLOSSARY.md` — English by decision, not by neglect. */
const BRAND_TERMS = new Set([
  'omadia', 'byte5', 'privacy shield', 'orchestrator', 'orchestrators',
  'conductor', 'turn', 'run', 'tool', 'tools', 'skill', 'skills', 'guard',
  'trace', 'token', 'tokens', 'cache', 'stream', 'sycophancy',
]);

/**
 * Algorithm and encoding names. They read like ordinary lowercase words, which
 * is exactly why `grep` mistook them for prose in #601 — but `sha256` localised
 * is a wrong value, not a translation.
 */
const TECH_TERMS = new Set([
  'sha1', 'sha256', 'sha512', 'md5', 'base64', 'utf-8', 'utf8', 'uuid', 'ulid',
  'cosine', 'euclidean', 'dotproduct', 'jaccard', 'bm25', 'regex', 'cron',
  'http', 'https', 'csv', 'tsv', 'xml', 'html', 'svg', 'png', 'jpg', 'pdf',
  'id', 'url', 'uri', 'api', 'sql', 'jwt', 'oauth', 'mcp', 'sse',
]);

/**
 * The exceptions `web-ui/CLAUDE.md` already documents, encoded so the scan does
 * not re-open a decision that was made once. Reading the rule beats re-arguing
 * it in every review — and a file listed here is a deliberate exception, not an
 * untouched one.
 */
const DOCUMENTED_EXCEPTIONS = new Map([
  ['global-error.tsx', 'renders when the intl provider itself has failed; intentionally bilingual'],
  ['chat/page.tsx', 'MOCK_KG_WALK is a dev-only fixture behind ?kgmock=1'],
]);

const REASONS = ['translate', 'review', 'spec-keyword', 'api-enum', 'code', 'placeholder', 'brand', 'symbol'];

/** A token that names something the machine reads, not something a human reads. */
function isCodeToken(tok) {
  const lower = tok.toLowerCase();
  if (TECH_TERMS.has(lower)) return true;
  if (SPEC_KEYWORDS.has(lower)) return true;
  if (tok.startsWith('/')) return true;                 // route: `/admin/duplicates`
  if (/[._\\/<>()[\]$@]/.test(tok)) return true;          // punctuation only code carries
  if (/^[a-z]+[A-Z]/.test(tok)) return true;            // camelCase
  return false;
}

/**
 * Order matters: the narrow, provable exemptions run before the catch-all.
 * `translate` is what is left over, which is the safe direction — a
 * misclassified exemption hides work, a misclassified `translate` only costs a
 * review comment.
 */
function classify(text) {
  const t = text.trim();
  const lower = t.toLowerCase();

  if (!/\p{L}/u.test(t)) return 'symbol';
  if (BRAND_TERMS.has(lower)) return 'brand';
  if (SPEC_KEYWORDS.has(lower)) return 'spec-keyword';

  // `HOT`, `WARM | COLD`, `PENDING/DONE` — API enum values echoed into a badge.
  if (/^[A-Z][A-Z0-9_]*([\s]*[|/,][\s]*[A-Z][A-Z0-9_]*)*$/.test(t)) return 'api-enum';

  // A format being demonstrated, not a sentence: `https://…`, `{orgId}`,
  // `user@example.com`. Localising these teaches a wrong value.
  //
  // Deliberately NOT keyed on a trailing ellipsis: `Suche…` is prose with an
  // ellipsis, and exempting it would hide real work — the failure direction
  // this script exists to avoid.
  if (/:\/\/|\{[^}]*\}|%[sd]/.test(t)) return 'placeholder';
  if (/^[\w.+-]+@[\w.-]+\.\w+$/.test(t)) return 'placeholder';

  // Classify by TOKEN, not by the whole string. `← /admin` is an arrow plus a
  // route; reading it as one blob made it look like prose in #601.
  const words = t.split(/\s+/).filter((w) => /\p{L}|\d/u.test(w));
  if (words.length > 0 && words.every(isCodeToken)) return 'code';

  if (t.length < 2) return 'symbol';

  // A single bare word is genuinely ambiguous: `Status` is a label to
  // translate, `triage` is an enum value to leave alone, and nothing in the
  // syntax distinguishes them. Splitting it out keeps `translate` a list
  // somebody can act on without re-reading every entry.
  return words.length === 1 ? 'review' : 'translate';
}

function stringValueOf(node) {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isJsxExpression(node)) return stringValueOf(node.expression);
  return undefined;
}

/**
 * Exported so `app/_lib/i18n-structural.test.ts` can ratchet on the SAME
 * classification the CLI reports. A test that re-implemented the rule would
 * drift from it, which is how #679's guard ended up naming three literal
 * strings while a fourth survived in the same file.
 */
export function scanFile(rel) {
  const src = readFileSync(resolve(APP_DIR, rel), 'utf8');
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits = [];

  const record = (node, text, kind, forcedReason) => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    hits.push({
      file: rel,
      line: line + 1,
      kind,
      text: trimmed,
      reason: forcedReason ?? classify(trimmed),
    });
  };

  const walk = (node) => {
    if (ts.isJsxText(node)) {
      // JSX collapses whitespace-only text between elements; those carry no
      // meaning and would otherwise dominate the report.
      record(node, node.text, 'jsx-text');
    } else if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) === false) {
      // namespaced attribute — ignore
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      if (USER_FACING_PROPS.has(name)) {
        const value = stringValueOf(node.initializer);
        if (value !== undefined) {
          // A one-word `placeholder=` is a format demo — `acme`, `api`,
          // `github_pat_…`. GLOSSARY.md: "a form hint teaches a FORMAT;
          // localising it teaches a wrong value."
          const forced =
            name === 'placeholder' && !/\s/.test(value.trim()) ? 'placeholder' : undefined;
          record(node, value, `prop:${name}`, forced);
        }
      }
    } else if (ts.isJsxExpression(node) && node.parent && ts.isJsxElement(node.parent)) {
      // `<p>{'literal'}</p>` — same thing as JSX text, written differently.
      const value = stringValueOf(node);
      if (value !== undefined) record(node, value, 'jsx-child-string');
    }
    ts.forEachChild(node, walk);
  };

  walk(sf);
  return { hits, wired: /use(Translations|Format)|getTranslations/.test(src) };
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const asJson = argv.includes('--json');
  const wantReason = flag('reason');
  const wantFile = flag('file');

  const files = globSync('**/*.tsx', { cwd: APP_DIR })
    .filter((f) => !f.includes('.test.') && !f.includes('__tests__'))
    .filter((f) => !DOCUMENTED_EXCEPTIONS.has(f))
    .filter((f) => (wantFile === undefined ? true : f.includes(wantFile)))
    .sort();

  const all = [];
  const unwired = [];
  for (const f of files) {
    const { hits, wired } = scanFile(f);
    all.push(...hits);
    if (!wired && hits.some((h) => h.reason === 'translate')) unwired.push(f);
  }

  const shown = wantReason === undefined ? all : all.filter((h) => h.reason === wantReason);

  if (asJson) {
    console.log(JSON.stringify({ files: files.length, hits: shown, unwired }, null, 2));
    return;
  }

  const byReason = Object.fromEntries(REASONS.map((r) => [r, 0]));
  for (const h of all) byReason[h.reason] += 1;

  console.log(`i18n-literal-scan: ${String(files.length)} files, ${String(all.length)} literals`);
  console.log(`(${String(DOCUMENTED_EXCEPTIONS.size)} file(s) skipped as documented exceptions — see web-ui/CLAUDE.md)\n`);
  for (const r of REASONS) {
    const note = r === 'translate' ? '  <- work' : r === 'review' ? '  <- needs a human call' : '';
    console.log(`  ${r.padEnd(13)} ${String(byReason[r]).padStart(4)}${note}`);
  }

  const perFile = new Map();
  for (const h of shown) perFile.set(h.file, (perFile.get(h.file) ?? 0) + 1);
  const ranked = [...perFile.entries()].sort((a, b) => b[1] - a[1]);

  console.log(`\n${String(ranked.length)} file(s)${wantReason === undefined ? '' : ` with reason '${wantReason}'`}:`);
  for (const [file, n] of ranked) {
    console.log(`  ${String(n).padStart(3)}  ${file}${unwired.includes(file) ? '   (no i18n hook yet)' : ''}`);
  }

  if (wantFile !== undefined || wantReason !== undefined) {
    console.log('');
    for (const h of shown) {
      console.log(`  ${h.file}:${String(h.line)}  [${h.reason}/${h.kind}]  ${JSON.stringify(h.text)}`);
    }
  }
}

// Only run the report when invoked as a CLI; the test imports `scanFile`.
if (process.argv[1] !== undefined && process.argv[1].endsWith('i18n-literal-scan.mjs')) {
  main();
}
