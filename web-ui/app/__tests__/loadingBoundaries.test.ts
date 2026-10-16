import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #1398 — where `loading.tsx` boundaries may sit.
 *
 * `notFound()` is detected as a literal call in the page file. A page that
 * reaches it through a helper must call it itself, or this guard (and its
 * 404 status) does not cover it.
 *
 * A loading boundary flushes the shell, and the `200` status line with it,
 * before the page below it runs. A page that then calls `notFound()` serves
 * the not-found UI with status 200. So:
 *
 *   1. no `loading.tsx` in or above the directory of a page that calls
 *      `notFound()`, or the 404 status is lost again;
 *   2. every other page has a boundary in or above its directory, or its
 *      navigations look dead while the payload is in flight (OM-96).
 *
 * Read from the file tree rather than listed by hand, so a new detail page or a
 * re-added root `app/loading.tsx` fails here.
 */

const APP_DIR = path.resolve(__dirname, '..');
/** Every extension Next accepts for a route convention file. */
const EXTENSIONS = ['tsx', 'ts', 'jsx', 'js'];
const conventionFile = (dir: string, name: string): string | undefined =>
  EXTENSIONS.map((ext) => path.join(dir, `${name}.${ext}`)).find((f) => existsSync(f));
const isPageFile = (entry: string): boolean => EXTENSIONS.some((ext) => entry === `page.${ext}`);

function listPages(dir: string): string[] {
  const pages: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry.startsWith('_')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) pages.push(...listPages(full));
    else if (isPageFile(entry)) pages.push(full);
  }
  return pages;
}

/** The page's directory and every ancestor up to and including `app/`. */
function dirsFromPageToApp(page: string): string[] {
  const dirs: string[] = [];
  let dir = path.dirname(page);
  for (;;) {
    dirs.push(dir);
    if (dir === APP_DIR) return dirs;
    dir = path.dirname(dir);
  }
}

/**
 * A `loading` file, or a layout/template that renders `<Suspense>` — either
 * one flushes the status line before the page below it runs.
 */
const hasBoundary = (dir: string): boolean =>
  conventionFile(dir, 'loading') !== undefined ||
  ['layout', 'template'].some((name) => {
    const file = conventionFile(dir, name);
    return file !== undefined && /<Suspense\b/.test(readFileSync(file, 'utf8'));
  });
const callsNotFound = (page: string): boolean =>
  /\bnotFound\(\)/.test(readFileSync(page, 'utf8'));
const rel = (p: string): string => path.relative(APP_DIR, p);

const pages = listPages(APP_DIR);
const notFoundPages = pages.filter(callsNotFound);

describe('loading boundaries vs. notFound() pages (#1398)', () => {
  it('finds the notFound() pages it guards', () => {
    expect(notFoundPages.map(rel).sort()).toEqual([
      'operator/agents/[slug]/page.tsx',
      'plugin-ui/[pluginId]/page.tsx',
      'routines/[id]/runs/[runId]/page.tsx',
      'store/[id]/page.tsx',
      'store/builder/[id]/page.tsx',
    ]);
  });

  it.each(notFoundPages.map(rel))('%s has no loading.tsx in or above it', (page) => {
    const offending = dirsFromPageToApp(path.join(APP_DIR, page)).filter(hasBoundary);
    expect(offending.map((d) => rel(d) || 'app/')).toEqual([]);
  });

  it.each(pages.filter((p) => !callsNotFound(p)).map(rel))(
    '%s has a loading boundary',
    (page) => {
      expect(dirsFromPageToApp(path.join(APP_DIR, page)).some(hasBoundary)).toBe(true);
    },
  );
});
