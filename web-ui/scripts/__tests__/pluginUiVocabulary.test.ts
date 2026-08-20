import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Doc ↔ source ↔ artifact parity for the plugin UI vocabulary (epic #470 C8b).
 *
 * THE FAILURE THIS EXISTS FOR. Tailwind's `@source inline()` expands BRACES.
 * A top-level comma is not a list separator, so
 *
 *     @source inline("border,border-{0,2,4}");
 *
 * asks Tailwind for three classes literally named `border,border-0`,
 * `border,border-2`, `border,border-4` — none of which exist, so the
 * declaration emits NOTHING. Three declarations were written that way
 * (`border`, `divide-*`, `transition*`), and the neighbouring ones use the
 * empty-alternative brace form (`rounded{,-none,-sm}`), which is what made it
 * invisible on review.
 *
 * It is worse than a missing utility. Tailwind's base reset is
 * `border: 0 solid`, so `class="border border-border"` — the most common
 * pairing in a ported page — set a colour on a ZERO-WIDTH border and rendered
 * invisible. No error, no warning, nothing in any build: exactly the silent-
 * unstyled failure the whole no-arbitrary-values contract exists to prevent,
 * sitting inside the artifact that enforces it.
 *
 * Two checks, deliberately in opposite directions:
 *
 *   1. SOURCE → ARTIFACT. Every class a `@source inline(...)` declaration
 *      claims must be in the generated sheet. Generic: it catches any
 *      declaration that silently emits nothing, not just this comma bug.
 *   2. DOC → ARTIFACT. Every class `plugin-ui-vocabulary.md` promises must be
 *      in the generated sheet. The document is the contract plugin authors
 *      read; a promise the artifact does not keep is a class that renders
 *      unstyled on an operator's screen and nowhere else.
 *
 * Both read the COMMITTED artifact rather than regenerating, because the
 * committed bytes are what middleware serves.
 */

const WEB_UI_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(WEB_UI_ROOT, '..');

const SOURCE_CSS = path.join(WEB_UI_ROOT, 'scripts/plugin-ui.source.css');
const ARTIFACT_CSS = path.join(
  REPO_ROOT,
  'middleware/assets/plugin-ui/plugin-ui.css',
);
const VOCABULARY_DOC = path.join(
  REPO_ROOT,
  'specs/470-dev-platform-plugin/plugin-ui-vocabulary.md',
);

/**
 * Tailwind's brace expansion: `a{,-b}` → `a`, `a-b`; `p-{0..2}` → `p-0`,
 * `p-1`, `p-2`; multiple groups cross-multiply. Nested groups are handled by
 * recursion. Anything unbalanced throws rather than silently expanding to
 * something plausible.
 */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];

  let depth = 0;
  let close = -1;
  for (let i = open; i < pattern.length; i += 1) {
    if (pattern[i] === '{') depth += 1;
    else if (pattern[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) throw new Error(`unbalanced brace group: ${pattern}`);

  const head = pattern.slice(0, open);
  const body = pattern.slice(open + 1, close);
  const tail = pattern.slice(close + 1);

  const alternatives: string[] = [];
  let nested = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '{') nested += 1;
    if (ch === '}') nested -= 1;
    if (ch === ',' && nested === 0) {
      alternatives.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  alternatives.push(current);

  const out: string[] = [];
  for (const alternative of alternatives) {
    const range = alternative.match(/^(\d+)\.\.(\d+)$/);
    if (range) {
      for (let n = Number(range[1]); n <= Number(range[2]); n += 1) {
        out.push(...expandBraces(`${head}${n}${tail}`));
      }
    } else {
      out.push(...expandBraces(`${head}${alternative}${tail}`));
    }
  }
  return out;
}

/**
 * The document's prefix-alternation shorthand, which the CSS source does not
 * have: `w-/h-{full,auto}` and `p-/px-/py-{0..2}` list several complete
 * prefixes; `shrink-0/1` lists several suffixes off one stem.
 */
function expandSlash(pattern: string): string[] {
  const brace = pattern.indexOf('{');
  const head = brace === -1 ? pattern : pattern.slice(0, brace);
  const tail = brace === -1 ? '' : pattern.slice(brace);
  if (!head.includes('/')) return [pattern];

  const parts = head.split('/');
  const first = parts[0] ?? '';
  const stem = first.slice(0, first.lastIndexOf('-') + 1);
  return parts.map((part, index) => {
    const complete = index === 0 || part.endsWith('-') || part.includes('-');
    return (complete ? part : stem + part) + tail;
  });
}

/**
 * Expand one documented pattern. Throws on notation the expander does not
 * understand — an ellipsis (`xs…7xl`) is a promise nothing can check, so the
 * document must spell the list out. Loud beats silently-skipped: a pattern
 * quietly dropped here is a class nobody verifies.
 */
function expandDocPattern(pattern: string): string[] {
  if (/[…]/.test(pattern)) {
    throw new Error(
      `un-expandable vocabulary pattern ${JSON.stringify(pattern)} — ` +
        'write the alternatives out in full rather than eliding them',
    );
  }
  return expandSlash(pattern).flatMap(expandBraces);
}

/** Every class name that has at least one rule in the generated stylesheet. */
function classesInArtifact(): ReadonlySet<string> {
  const css = readFileSync(ARTIFACT_CSS, 'utf-8');
  const present = new Set<string>();
  // Selectors escape `:` and `.` with a backslash (`.hover\:bg-accent`);
  // unescape so the set is keyed by the class name an author would write.
  for (const match of css.matchAll(/\.((?:\\.|[A-Za-z0-9_-])+)/g)) {
    present.add((match[1] ?? '').replace(/\\(.)/g, '$1'));
  }
  return present;
}

const codeSpans = (line: string): string[] =>
  [...line.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? '');

describe('plugin UI vocabulary — source ↔ artifact', () => {
  it('emits every class the source declares', () => {
    const present = classesInArtifact();
    const source = readFileSync(SOURCE_CSS, 'utf-8');

    const broken: string[] = [];
    let declared = 0;

    source.split('\n').forEach((line, index) => {
      const match = line.match(/^@source\s+inline\("([^"]*)"\);/);
      if (!match) return;
      const declaration = match[1] ?? '';
      const classes = expandBraces(declaration);
      declared += classes.length;
      const missing = classes.filter((c) => !present.has(c));
      if (missing.length > 0) {
        broken.push(
          `  line ${index + 1}: @source inline("${declaration}")\n` +
            `      emits nothing for ${missing.length}/${classes.length}: ` +
            `${missing.slice(0, 5).join(' ')}${missing.length > 5 ? ' …' : ''}`,
        );
      }
    });

    // A floor, so a regex that stops matching degenerates into a red test
    // rather than a green one that checks nothing.
    expect(declared).toBeGreaterThan(600);
    expect(
      broken.join('\n'),
      'A declaration produced no CSS. The usual cause is a TOP-LEVEL COMMA: ' +
        '`@source inline()` expands braces only, so "a,b-{1,2}" asks for classes ' +
        'literally named "a,b-1". Write "a{,-b}" or "{a,b}-{1,2}" instead, then ' +
        'rerun `npm run plugin-ui:css`.',
    ).toBe('');
  });
});

describe('plugin UI vocabulary — doc ↔ artifact', () => {
  it('emits every class plugin-ui-vocabulary.md promises', () => {
    const present = classesInArtifact();
    const doc = readFileSync(VOCABULARY_DOC, 'utf-8');

    const from = doc.indexOf('## The vocabulary');
    const to = doc.indexOf('### Baseline element styling');
    expect(from, 'vocabulary section heading moved').toBeGreaterThan(-1);
    expect(to, 'baseline-styling heading moved').toBeGreaterThan(from);

    const promised = new Set<string>();
    for (const raw of doc.slice(from, to).split('\n')) {
      const line = raw.trim();
      if (line === '') continue;

      if (line.startsWith('|')) {
        // A table separator row (`|---|---|`) carries no classes.
        if (/^\|[\s:|-]+\|$/.test(line)) continue;
      } else {
        // A prose line is only a vocabulary list when nothing but code spans
        // and separators survives. That is what keeps the Colour section's
        // "`bg-blue-500` does not exist" out of the promised set.
        const residue = line.replace(/`[^`\n]+`/g, '');
        if (!/^[\s·+()]*$/.test(residue)) continue;
      }

      const spans = codeSpans(line);
      if (spans.length === 0) continue;

      // Three kinds of span share a row: a bare variant (`hover:`), a bare
      // prefix (`bg-`, from the Colour table's own column), and a pattern.
      const variants = spans.filter((s) => /^[a-z-]+:$/.test(s));
      const prefixes = spans.filter((s) => s.endsWith('-'));
      const patterns = spans.filter(
        (s) => !variants.includes(s) && !prefixes.includes(s),
      );

      const base =
        prefixes.length > 0
          ? prefixes.flatMap((prefix) =>
              patterns.flatMap((pattern) => expandDocPattern(prefix + pattern)),
            )
          : patterns.flatMap((pattern) => expandDocPattern(pattern));

      for (const cls of base) {
        promised.add(cls);
        for (const variant of variants) promised.add(variant + cls);
      }
    }

    expect(promised.size).toBeGreaterThan(600);

    const missing = [...promised].filter((c) => !present.has(c)).sort();
    expect(
      missing,
      'The document promises classes the generated stylesheet does not contain. ' +
        'An author who follows the doc writes a class that does nothing, silently. ' +
        'Fix web-ui/scripts/plugin-ui.source.css (or the doc, if the promise was ' +
        'wrong), then rerun `npm run plugin-ui:css`.',
    ).toEqual([]);
  });

  it('promises the utilities whose absence made the ported pages render unstyled', () => {
    // Pinned by name: these three groups are the reported defect, and a
    // regression in any of them must name itself rather than arriving as one
    // line in a 700-element diff.
    const present = classesInArtifact();
    for (const cls of [
      'border',
      'border-0',
      'border-2',
      'border-4',
      'divide-y',
      'divide-x',
      'transition',
      'transition-none',
      'transition-all',
      'transition-colors',
      'transition-opacity',
      'transition-transform',
    ]) {
      expect(present.has(cls), `${cls} missing from the generated stylesheet`).toBe(
        true,
      );
    }
  });
});
