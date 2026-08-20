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
]);

/**
 * Exemptions that are scoped to a SYMBOL, not a file.
 *
 * `web-ui/CLAUDE.md` exempts `MOCK_KG_WALK` — a dev-only fixture behind
 * `?kgmock=1` — not all of `chat/page.tsx`. Skipping the whole file was the
 * cheap reading, and it hid a hardcoded German `title=` tooltip 1100 lines
 * below the fixture. An exemption must be no wider than the thing it excuses.
 */
const EXEMPT_DECLARATIONS = new Map([['chat/page.tsx', ['MOCK_KG_WALK']]]);

/** True when `node` sits inside one of the file's exempt declarations. */
function isInExemptDeclaration(node, rel, sf) {
  const names = EXEMPT_DECLARATIONS.get(rel);
  if (names === undefined) return false;
  for (let p = node.parent; p !== undefined && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isVariableDeclaration(p) && names.includes(p.name.getText(sf))) return true;
  }
  return false;
}

const REASONS = ['translate', 'review', 'diagnostic', 'spec-keyword', 'api-enum', 'code', 'placeholder', 'brand', 'symbol'];

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

  // German in a component file is the severest class in `web-ui/CLAUDE.md`
  // ("German belongs only in messages/de.json"), so it outranks every
  // exemption below — a German string is never a placeholder or an enum value.
  //
  // Precision over recall on purpose: umlauts and ß never appear in the English
  // source, so this cannot false-positive, but it also cannot catch
  // umlaut-free German like `Triage-Klassifizierer`. Those still surface as
  // `review`, which is the honest answer — no cheap test tells the two
  // languages apart, and guessing would put real English labels in the wrong
  // bucket.
  if (/[äöüÄÖÜß]/.test(t)) return 'translate';
  if (BRAND_TERMS.has(lower)) return 'brand';
  if (SPEC_KEYWORDS.has(lower)) return 'spec-keyword';

  // `HOT`, `WARM | COLD`, `PENDING/DONE` — API enum values echoed into a badge.
  if (/^[A-Z][A-Z0-9_]*([\s]*[|/,][\s]*[A-Z][A-Z0-9_]*)*$/.test(t)) return 'api-enum';

  // A version, phase or build stamp: `omadia · v1`, `B.0 Draft-Store`,
  // `Phase B.5 (Workspace-UI)`, `omadia · v1 · Slice 1.1`. These sit in product
  // footers and read like prose, but localising them changes an identifier an
  // operator quotes back in a bug report. Whether they belong in the UI at all
  // is a product question — the scan's job is only to keep them out of the
  // translation list.
  if (/(^|[\s·])(v\d+|[A-Z]\.?\d+(\.\d+)*)([\s·]|$)/.test(t)) return 'diagnostic';

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
  // A template literal WITH substitutions is the shape interpolated status
  // lines use — `title={`Triage classifier: ${a} → ${b}`}`. The first version
  // of this scan could not see them at all, which hid a hardcoded GERMAN
  // tooltip that the repo's own `git diff | grep '[äöüÄÖÜß]'` self-check also
  // misses (no umlauts in "Triage-Klassifizierer"). Rendered with `{}` in
  // place of each substitution, which is both what the ICU key will look like
  // and enough for the classifier to judge the surrounding prose.
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((sp) => `{}${sp.literal.text}`)].join('');
  }
  return undefined;
}

/**
 * The text a hit is CLASSIFIED on, which is not always the text it is SHOWN as.
 *
 * A template literal is displayed with `{}` where each substitution was — that
 * is what the eventual ICU key looks like. But `{...}` is also how `classify`
 * recognises a format-illustrating placeholder, so classifying the display form
 * would mark every interpolated string as an exempt placeholder and silently
 * re-hide the class this scan was just extended to see. Classify on the literal
 * parts alone.
 */
function classifiableText(node, display) {
  const inner = ts.isJsxExpression(node) ? node.expression : node;
  if (inner !== undefined && ts.isTemplateExpression(inner)) {
    return [inner.head.text, ...inner.templateSpans.map((sp) => sp.literal.text)].join(' ');
  }
  return display;
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

  const record = (node, text, kind, forcedReason, valueNode) => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    if (isInExemptDeclaration(node, rel, sf)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    hits.push({
      file: rel,
      line: line + 1,
      kind,
      text: trimmed,
      reason: forcedReason ?? classify(classifiableText(valueNode ?? node, trimmed).trim()),
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
          // A `placeholder=` is a judgement call by nature, and the first
          // triage pass proved it: of six hits, five were example VALUES that
          // must not be translated (`Release sign-off`, `Release approver`,
          // `id-1, id-2, …`, `email | uri | date-time | uuid`) and one was a
          // real instruction (`Reason (optional)`). GLOSSARY.md: "a form hint
          // teaches a FORMAT; localising it teaches a wrong value." Nothing in
          // the syntax separates the two, so they go to `review` — except the
          // single-token case, which is unambiguously a format demo.
          const trimmedValue = value.trim();
          const forced =
            name !== 'placeholder'
              ? undefined
              : /\s/.test(trimmedValue)
                ? 'review'
                : 'placeholder';
          record(node, value, `prop:${name}`, forced, node.initializer);
        }
      }
    } else if (
      ts.isPropertyAssignment(node) &&
      USER_FACING_PROPS.has(node.name.getText(sf))
    ) {
      // A user-facing string can also live in a plain object that is rendered
      // later — `const verdict = { simple: { label: 'einfach' } }` then
      // `<span>{v.label}</span>`. Neither JSX text nor a JSX prop, so the first
      // version of this scan could not see it, and two GERMAN badge labels sat
      // there. Restricted to the same closed prop list, so a `label` on an API
      // payload is the only kind of false positive this can produce — and a
      // false `review` costs a comment, while a miss costs a shipped bug.
      const value = stringValueOf(node.initializer);
      if (value !== undefined) {
        record(node, value, `obj:${node.name.getText(sf)}`, undefined, node.initializer);
      }
    } else if (ts.isJsxExpression(node) && node.parent && ts.isJsxElement(node.parent)) {
      // `<p>{'literal'}</p>` — same thing as JSX text, written differently.
      const value = stringValueOf(node);
      if (value !== undefined) record(node, value, 'jsx-child-string', undefined, node);
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
