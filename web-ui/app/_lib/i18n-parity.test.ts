import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TYPE,
  parse as parseIcu,
  type MessageFormatElement,
} from '@formatjs/icu-messageformat-parser';
import { describe, expect, it } from 'vitest';

type MessageNode = string | { [key: string]: MessageNode };
type MessageMap = ReadonlyMap<string, string>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const MESSAGES_DIR = path.resolve(HERE, '..', '..', 'messages');

/** English is the source of truth; every other locale is compared against it. */
const REFERENCE_LOCALE = 'en';

function flattenKeys(obj: Record<string, MessageNode>, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      for (const [k, v] of flattenKeys(value, full)) out.set(k, v);
    } else if (typeof value === 'string') {
      out.set(full, value);
    } else {
      throw new Error(`Unexpected value type for key ${full}: ${typeof value}`);
    }
  }
  return out;
}

/**
 * Locales are DISCOVERED from `messages/*.json`, never hardcoded.
 *
 * The original version of this guard imported `en.json` and `de.json` by name
 * and only ever resolved messages from `en`. A `<tag>` that exists in `de.json`
 * with no matching handler therefore crashed for German users while the guard
 * stayed green — the same locale-specific-crash class the guard was written to
 * close. Adding a third locale would have silently escaped it too.
 */
function loadLocales(): Map<string, MessageMap> {
  const out = new Map<string, MessageMap>();
  for (const entry of fs.readdirSync(MESSAGES_DIR).sort()) {
    if (!entry.endsWith('.json')) continue;
    const raw = JSON.parse(
      fs.readFileSync(path.join(MESSAGES_DIR, entry), 'utf8'),
    ) as Record<string, MessageNode>;
    out.set(entry.slice(0, -'.json'.length), flattenKeys(raw));
  }
  return out;
}

const LOCALES = loadLocales();

function localeMessages(locale: string): MessageMap {
  const messages = LOCALES.get(locale);
  if (!messages) throw new Error(`No message catalog for locale '${locale}' in ${MESSAGES_DIR}`);
  return messages;
}

const FORBIDDEN_HTML = /<\s*(script|iframe|object|embed|link)[\s>]/i;

// ── ICU-aware placeholder analysis ──────────────────────────────────────────

/**
 * What a message *declares*: ICU arguments and rich-text tags, kept apart.
 *
 * The distinction is the whole point. `{name}` and `<name>…</name>` are two
 * different contracts against the same handler key, and confusing them is what
 * took /routines down (see the `t.rich` block below). A regex that only looks
 * for `/\{(\w+)\}/` also misses every ICU sub-message — `{count, plural, one
 * {…} other {…}}` declares the argument `count`, but the naive pattern matches
 * nothing at all, so a plural whose argument was renamed in one locale slipped
 * through unnoticed.
 */
interface PlaceholderSignature {
  /** ICU argument names (simple, number, date, time, select, plural). */
  readonly args: readonly string[];
  /** Rich-text tag names (`<tag>…</tag>`). */
  readonly tags: readonly string[];
  /** False when the message is not valid ICU and the regex fallback was used. */
  readonly parsed: boolean;
}

function walkIcu(
  elements: readonly MessageFormatElement[],
  args: Set<string>,
  tags: Set<string>,
): void {
  for (const element of elements) {
    switch (element.type) {
      case TYPE.argument:
      case TYPE.number:
      case TYPE.date:
      case TYPE.time:
        args.add(element.value);
        break;
      case TYPE.select:
      case TYPE.plural:
        args.add(element.value);
        for (const option of Object.values(element.options)) walkIcu(option.value, args, tags);
        break;
      case TYPE.tag:
        tags.add(element.value);
        walkIcu(element.children, args, tags);
        break;
      default:
        break;
    }
  }
}

/** Matches `{name}` and the argument of `{name, plural, …}` / `{name, select, …}`. */
const ARG_FALLBACK_RE = /\{\s*([A-Za-z0-9_]+)\s*[,}]/g;
const TAG_FALLBACK_RE = /<\s*([A-Za-z0-9_]+)[\s>/]/g;

/**
 * A handful of catalog entries are prose that merely *contains* `<` or `{`
 * (`Props: { data: unknown }`, `role:<key>`) and are not valid ICU. They are
 * symmetric across locales, so rather than fail the build on pre-existing
 * content we degrade to the regex extraction — which still compares something,
 * and the `parsed` flag itself is compared so a message that parses in one
 * locale but not another is reported.
 */
function placeholderSignature(message: string): PlaceholderSignature {
  const args = new Set<string>();
  const tags = new Set<string>();
  try {
    walkIcu(parseIcu(message), args, tags);
    return { args: [...args].sort(), tags: [...tags].sort(), parsed: true };
  } catch {
    for (const m of message.matchAll(ARG_FALLBACK_RE)) args.add(m[1] ?? '');
    for (const m of message.matchAll(TAG_FALLBACK_RE)) tags.add(m[1] ?? '');
    return { args: [...args].sort(), tags: [...tags].sort(), parsed: false };
  }
}

describe('i18n message parity (all locales in messages/)', () => {
  const reference = localeMessages(REFERENCE_LOCALE);
  const others = [...LOCALES.keys()].filter((l) => l !== REFERENCE_LOCALE);

  it('discovers more than one locale (guards against a vacuous pass)', () => {
    // If the loader silently found nothing but `en`, every cross-locale check
    // below degenerates into comparing en with itself and passes vacuously.
    expect(others.length, `only found locales: ${[...LOCALES.keys()].join(', ')}`).toBeGreaterThan(
      0,
    );
    expect(reference.size).toBeGreaterThan(100);
  });

  it('every locale has the same key set as the reference locale', () => {
    const referenceKeys = [...reference.keys()].sort();
    for (const locale of others) {
      expect([...localeMessages(locale).keys()].sort(), `key set drift in ${locale}.json`).toEqual(
        referenceKeys,
      );
    }
  });

  it('every key has a non-empty string value in every locale', () => {
    for (const [locale, messages] of LOCALES) {
      for (const [key, value] of messages) {
        expect(value, `${locale}.${key} is empty`).not.toBe('');
      }
    }
  });

  it('no value contains forbidden HTML (script/iframe/object/embed/link)', () => {
    for (const [locale, messages] of LOCALES) {
      for (const [key, value] of messages) {
        expect(FORBIDDEN_HTML.test(value), `${locale}.${key} contains forbidden HTML`).toBe(false);
      }
    }
  });

  it('ICU arguments and rich-text tags match across locales for the same key', () => {
    for (const locale of others) {
      const messages = localeMessages(locale);
      for (const [key, referenceValue] of reference) {
        const value = messages.get(key);
        if (typeof value !== 'string') continue; // covered by the key-set test
        const expected = placeholderSignature(referenceValue);
        const actual = placeholderSignature(value);
        expect(actual, `placeholder mismatch on '${key}' (${REFERENCE_LOCALE} vs ${locale})`).toEqual(
          expected,
        );
      }
    }
  });
});

/**
 * Regression guard for the `t.rich` argument/tag mismatch bug class.
 *
 * `t.rich('key', { name: () => <code/> })` supplies a *function* handler. That
 * is only valid when the message declares `name` as a rich-text **tag**
 * (`<name>…</name>`). If the message instead declares it as an ICU
 * **argument** (`{name}`), intl-messageformat substitutes the raw function
 * into the output parts.
 *
 * In a Client Component React silently drops the function (the markup just
 * vanishes). In a **Server** Component the Flight serializer rejects it with
 * "Functions are not valid as a child of Client Components", which surfaces to
 * the user as the generic error page plus an opaque `digest` — inside an
 * HTTP 200 response, so nothing looks failed in the network tab.
 *
 * That is what made the entire /routines section permanently unreachable
 * (customer findings OM-14 / OM-19 / OM-32). Key parity could never catch it:
 * the key existed in both locales, it was the *placeholder syntax* that was
 * wrong. This test closes the class — for EVERY locale, because the crash is
 * decided by the message the *viewer's* locale ships, not by `en.json`.
 */
function collectTsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      collectTsxFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Splits an object-literal body into its top-level `key: value` entries. */
function splitTopLevelEntries(body: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    if (i === body.length || (body[i] === ',' && depth === 0)) {
      entries.push(body.slice(start, i));
      start = i + 1;
      continue;
    }
    const c = body[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
  }
  return entries;
}

/** One `t.rich(key, { handler: () => … })` function handler at one call site. */
interface RichHandlerUse {
  readonly file: string;
  readonly line: number;
  readonly messageKey: string;
  readonly handler: string;
}

interface RichViolation extends RichHandlerUse {
  readonly locale: string;
  readonly detail: string;
}

/**
 * The sources the scanner reads. Injectable so the guard itself can be tested
 * against a synthetic file + synthetic catalogs — writing a deliberate
 * violation into `messages/de.json` to prove the scanner works would leave
 * residue in a version-controlled file.
 */
interface RichScanSource {
  readonly files: readonly string[];
  readonly readFile: (file: string) => string;
  readonly label: (file: string) => string;
}

function repoRichScanSource(): RichScanSource {
  return {
    files: collectTsxFiles(APP_DIR),
    readFile: (file) => fs.readFileSync(file, 'utf8'),
    label: (file) => path.relative(APP_DIR, file),
  };
}

function collectRichHandlerUses(source: RichScanSource): RichHandlerUse[] {
  const uses: RichHandlerUse[] = [];

  for (const file of source.files) {
    const src = source.readFile(file);
    if (!src.includes('.rich(')) continue;

    // Map each `const t = useTranslations('ns')` to its namespace.
    const decls: Array<{ idx: number; varName: string; ns: string }> = [];
    const declRe =
      /const\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\s*\(\s*['"]([^'"]+)['"]/g;
    let d: RegExpExecArray | null;
    while ((d = declRe.exec(src))) {
      decls.push({ idx: d.index, varName: d[1] ?? '', ns: d[2] ?? '' });
    }

    const richRe = /(\w+)\.rich\(\s*['"]([^'"]+)['"]\s*,\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = richRe.exec(src))) {
      const varName = m[1] ?? '';
      const key = m[2] ?? '';
      const callIdx = m.index;
      const decl = decls.filter((x) => x.varName === varName && x.idx < callIdx).pop();
      if (!decl) continue;

      // Brace-match the handler object literal.
      const open = m.index + m[0].length - 1;
      let depth = 0;
      let end = -1;
      for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) continue;

      const line = src.slice(0, m.index).split('\n').length;
      for (const entry of splitTopLevelEntries(src.slice(open + 1, end))) {
        const kv = entry.match(/^\s*([A-Za-z0-9_]+)\s*:\s*([\s\S]*)$/);
        if (!kv) continue;
        const handler = kv[1] ?? '';
        const value = kv[2] ?? '';
        const isFunction = /^\(?[A-Za-z0-9_,\s:<>[\]{}]*\)?\s*=>/.test(value.trim());
        if (!isFunction) continue; // plain ICU values are fine

        uses.push({ file: source.label(file), line, messageKey: `${decl.ns}.${key}`, handler });
      }
    }
  }
  return uses;
}

function findRichViolations(
  locales: ReadonlyMap<string, MessageMap> = LOCALES,
  source: RichScanSource = repoRichScanSource(),
): RichViolation[] {
  const violations: RichViolation[] = [];
  for (const use of collectRichHandlerUses(source)) {
    for (const [locale, messages] of locales) {
      const message = messages.get(use.messageKey);
      if (typeof message !== 'string') continue;

      const { args, tags } = placeholderSignature(message);
      if (tags.includes(use.handler)) continue;

      violations.push({
        ...use,
        locale,
        detail: args.includes(use.handler)
          ? `${locale}.json declares {${use.handler}} as an ICU argument, but a function handler was passed — use <${use.handler}>…</${use.handler}>`
          : `${locale}.json declares neither <${use.handler}> nor {${use.handler}} — the handler is dead`,
      });
    }
  }
  return violations;
}

describe('t.rich handlers match their message placeholders', () => {
  it('every function handler corresponds to a <tag> in EVERY locale', () => {
    const violations = findRichViolations();
    const report = violations
      .map((v) => `  [${v.locale}] ${v.file}:${v.line} — ${v.messageKey}: ${v.detail}`)
      .join('\n');
    expect(violations, `t.rich argument/tag mismatches found:\n${report}`).toEqual([]);
  });

  it('the scanner actually inspects call sites (guards against a silent no-op)', () => {
    // If this drops to 0 the scanner has broken (e.g. a refactor changed how
    // translators are declared) and the guard above would pass vacuously.
    const richCallSites = collectTsxFiles(APP_DIR).filter((f) =>
      fs.readFileSync(f, 'utf8').includes('.rich('),
    );
    expect(richCallSites.length).toBeGreaterThan(10);
  });

  it('the scanner resolves messages in every locale (guards the multi-locale path)', () => {
    // The per-locale twin of the check above. Resolving handler uses but then
    // finding none of their keys in, say, `de.json` would make the German half
    // of the guard silently inert — exactly the failure mode being fixed.
    const uses = collectRichHandlerUses(repoRichScanSource());
    expect(uses.length).toBeGreaterThan(10);
    for (const [locale, messages] of LOCALES) {
      const resolved = uses.filter((u) => typeof messages.get(u.messageKey) === 'string');
      expect(resolved.length, `no t.rich message keys resolved in ${locale}.json`).toBeGreaterThan(
        10,
      );
    }
  });

  it('catches a violation that exists ONLY in a non-reference locale', () => {
    // The bug this whole block guards against is locale-specific: the message
    // `en` ships is fine, the one `de` ships crashes. Fixtures are injected, so
    // nothing is written to messages/*.json.
    const source: RichScanSource = {
      files: ['virtual/DeOnlyRich.tsx'],
      readFile: () =>
        [
          "const t = useTranslations('fixture');",
          "export function C() { return <p>{t.rich('greeting', { link: (chunks) => <a href=\"/x\">{chunks}</a> })}</p>; }",
        ].join('\n'),
      label: (file) => file,
    };
    const locales = new Map<string, MessageMap>([
      ['en', new Map([['fixture.greeting', 'Hello <link>world</link>']])],
      ['de', new Map([['fixture.greeting', 'Hallo {link}']])],
    ]);

    const violations = findRichViolations(locales, source);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.locale).toBe('de');
    expect(violations[0]?.messageKey).toBe('fixture.greeting');
    expect(violations[0]?.handler).toBe('link');
    expect(violations[0]?.detail).toContain('ICU argument');
  });

  it('also catches an ICU-plural-only mismatch and stays quiet when both locales are correct', () => {
    const source: RichScanSource = {
      files: ['virtual/PluralRich.tsx'],
      readFile: () =>
        [
          "const t = useTranslations('fixture');",
          "export function C() { return <p>{t.rich('count', { b: (chunks) => <b>{chunks}</b> })}</p>; }",
        ].join('\n'),
      label: (file) => file,
    };
    const broken = new Map<string, MessageMap>([
      ['en', new Map([['fixture.count', '{n, plural, one {<b>#</b> item} other {<b>#</b> items}}']])],
      ['de', new Map([['fixture.count', '{n, plural, one {{b} Eintrag} other {{b} Einträge}}']])],
    ]);
    // The tag lives inside a plural sub-message — only an ICU-aware walk finds
    // it, a flat `/<b[>\s/]/` scan of the raw string would too, but the `{b}`
    // side needs the parser to be reported as an *argument* rather than "dead".
    const brokenViolations = findRichViolations(broken, source);
    expect(brokenViolations).toHaveLength(1);
    expect(brokenViolations[0]?.locale).toBe('de');
    expect(brokenViolations[0]?.detail).toContain('ICU argument');

    const fixed = new Map<string, MessageMap>([
      ['en', new Map([['fixture.count', '{n, plural, one {<b>#</b> item} other {<b>#</b> items}}']])],
      [
        'de',
        new Map([['fixture.count', '{n, plural, one {<b>#</b> Eintrag} other {<b>#</b> Einträge}}']]),
      ],
    ]);
    // Proves the fixture is not simply always-failing.
    expect(findRichViolations(fixed, source)).toEqual([]);
  });
});
