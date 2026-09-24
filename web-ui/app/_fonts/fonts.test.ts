import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The build must never depend on a font CDN.
 *
 * `next/font/google` self-hosts at runtime but downloads at build time, so a
 * runner without `fonts.googleapis.com` fails the whole build. That happened on
 * `7a0d4675`: four `Failed to fetch <family> from Google Fonts` errors took out
 * the macOS x64 desktop build, and with it the release's x64 artifact,
 * `mac-update-feed` and `promote-release`.
 *
 * These tests pin the three things that keep it fixed: no `next/font/google`
 * import survives anywhere, every face `app/_fonts/index.ts` names is actually
 * committed, and the CSS variable names other code depends on are unchanged.
 *
 * ESLint blocks the import too (`no-restricted-imports`). Both, deliberately:
 * a lint rule can be disabled inline, and this suite runs in CI regardless.
 */

const FONT_DIR = join(process.cwd(), 'app/_fonts');
const APP_DIR = join(process.cwd(), 'app');

/** Every source file under `app/`, so no directory is silently skipped. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const indexSource = readFileSync(join(FONT_DIR, 'index.ts'), 'utf8');

describe('vendored fonts', () => {
  it('nothing in app/ imports next/font/google', () => {
    const offenders = sourceFiles(APP_DIR)
      .filter((file) => /from\s+['"]next\/font\/google/.test(readFileSync(file, 'utf8')))
      .map((file) => file.replace(process.cwd(), '.'));

    expect(offenders).toEqual([]);
  });

  it('app/_fonts/index.ts loads every face from a committed file', () => {
    const referenced = [...indexSource.matchAll(/path:\s*'\.\/([^']+\.woff2)'/g)].flatMap((m) =>
      m[1] ? [m[1]] : [],
    );

    // Four registers: sans, serif, mono, wordmark.
    expect(referenced).toHaveLength(4);

    for (const file of referenced) {
      const stat = statSync(join(FONT_DIR, file));
      expect(stat.isFile(), `${file} is a file`).toBe(true);
      // A truncated or placeholder woff2 would still "exist"; a real subset of
      // these families is several kilobytes.
      expect(stat.size, `${file} has real bytes`).toBeGreaterThan(5_000);
      // wOF2 magic number, so a renamed ttf or an HTML error page fails here.
      expect(
        readFileSync(join(FONT_DIR, file)).subarray(0, 4).toString('latin1'),
        `${file} is woff2`,
      ).toBe('wOF2');
    }
  });

  it('keeps the CSS variable names the rest of the app composes', () => {
    // theme.css builds --font-sans / --font-serif / --font-mono out of these,
    // and globals.css keys .font-logo off --font-days-one. Renaming one here
    // silently drops a register to its fallback stack.
    for (const variable of [
      '--font-geist',
      '--font-source-serif',
      '--font-geist-mono',
      '--font-days-one',
    ]) {
      expect(indexSource).toContain(`variable: '${variable}'`);
    }
  });

  it('scopes the faces to the latin range they actually cover', () => {
    // Without unicode-range the browser uses these files for Cyrillic and Greek
    // too, which have no glyphs here, and renders tofu instead of falling
    // through to the platform stack.
    expect(indexSource).toContain('unicode-range');
    expect(indexSource).toContain('U+0000-00FF');
  });

  it('ships the OFL text for every vendored family', () => {
    const licenses = readdirSync(FONT_DIR).filter((f) => f.endsWith('-OFL.txt'));
    expect(licenses).toHaveLength(4);

    for (const file of licenses) {
      expect(readFileSync(join(FONT_DIR, file), 'utf8')).toContain('SIL OPEN FONT LICENSE');
    }
  });
});
