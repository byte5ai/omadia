import localFont from 'next/font/local';

/**
 * Typography per the Lume spec (§2.7) — three registers, three variable
 * families, plus the brand wordmark face.
 *
 * These used to come from `next/font/google`. That helper self-hosts the files
 * at runtime, but it DOWNLOADS them at build time, so any build runner without
 * access to fonts.googleapis.com fails the whole build. That is not
 * hypothetical: on `7a0d4675` the macOS x64 desktop build died with four
 * `next/font: error: Failed to fetch <family> from Google Fonts` errors, which
 * left the release without an x64 artifact, failed `mac-update-feed`, failed
 * `promote-release`, and kept the release a draft.
 *
 * So the woff2 files live in this directory and are loaded with
 * `next/font/local`. The build no longer touches the network. Adding a family
 * means vendoring its file here, not adding an import — a lint rule forbids
 * `next/font/google` outright (see `eslint.config.mjs`), and `fonts.test.ts`
 * fails if one slips back in. Provenance per file is in `LICENSES.md` and
 * `.vendor-manifest.json`.
 *
 * What is preserved verbatim from the previous `next/font/google` setup:
 *   - the CSS variable names (`--font-geist`, `--font-source-serif`,
 *     `--font-geist-mono`, `--font-days-one`), which `_lib/theme.css` composes
 *     into `--font-sans` / `--font-serif` / `--font-mono`
 *   - `display: 'swap'` on every face
 *   - Geist preloaded for FCP; prose, mono and wordmark deferred (§2.7)
 *   - the variable weight ranges and the latin `unicode-range`, both taken
 *     from Google's own CSS2 response
 *
 * The one deliberate difference: `adjustFontFallback` is named explicitly.
 * `next/font/google` derived the fallback-override metrics from the family's
 * own category; for local fonts Next needs the reference family, so the serif
 * register points at Times New Roman and the rest at Arial.
 *
 * The `unicode-range` literal is repeated in all four calls on purpose.
 * `next/font` rejects any option value that is not an explicitly written
 * literal ("Font loader values must be explicitly written literals"), so a
 * shared constant does not compile. It matters that it is here at all: without
 * it the browser would use these faces for codepoints they have no glyphs for
 * (Cyrillic, Greek) and render tofu instead of falling through to the platform
 * stack in `theme.css`.
 */

/** Structural register: UI, labels, headings, buttons. Preloaded. */
export const sans = localFont({
  src: [{ path: './geist-latin.woff2', weight: '100 900', style: 'normal' }],
  variable: '--font-geist',
  display: 'swap',
  adjustFontFallback: 'Arial',
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
});

/** Prose register: long-form agent narration. */
export const serif = localFont({
  src: [{ path: './source-serif-4-latin.woff2', weight: '200 900', style: 'normal' }],
  variable: '--font-source-serif',
  display: 'swap',
  preload: false,
  adjustFontFallback: 'Times New Roman',
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
});

/** Data and code register: IDs, numbers, code, paths. */
export const mono = localFont({
  src: [{ path: './geist-mono-latin.woff2', weight: '100 900', style: 'normal' }],
  variable: '--font-geist-mono',
  display: 'swap',
  preload: false,
  adjustFontFallback: 'Arial',
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
});

/**
 * Brand wordmark only — the omadia logo (header + login card) keeps the
 * original Days One face. Lume headings elsewhere stay on Geist per §2.7
 * (see globals.css .font-display); this is a separate `.font-logo` class
 * so the wordmark can diverge without reopening that decision sitewide.
 */
export const logo = localFont({
  src: [{ path: './days-one-latin.woff2', weight: '400', style: 'normal' }],
  variable: '--font-days-one',
  display: 'swap',
  preload: false,
  adjustFontFallback: 'Arial',
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
});

/** Every font variable this app defines, for the `<html>` class list. */
export const fontVariables = [sans.variable, serif.variable, mono.variable, logo.variable].join(
  ' ',
);
