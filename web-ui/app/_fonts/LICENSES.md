# Vendored font files

These woff2 files are committed on purpose. `next/font/google` self-hosts the
faces it serves, but it downloads them **at build time**, so every build needs
`fonts.googleapis.com`. On merge commit `7a0d4675` the macOS x64 desktop build
failed with four `next/font: error: Failed to fetch <family> from Google Fonts`
errors, which left the release without an x64 artifact, failed
`desktop-apps / mac-update-feed`, failed `promote-release`, and kept the release
a draft. Vendoring removes the network from the build entirely.

`app/_fonts/index.ts` loads them with `next/font/local`, and an ESLint rule
(`no-restricted-imports` in `web-ui/eslint.config.mjs`) blocks
`next/font/google` so this cannot regress.

## What is here, and why exactly this

Each file is the **latin** subset only, because that is what `layout.tsx`
requested from `next/font/google` (`subsets: ['latin']`). The three text
families are variable fonts, so one file covers the whole weight range. The
files, the weight ranges and the `unicode-range` were taken from Google's own
CSS2 response, fetched through `next/font`'s own URL builder
(`get-google-fonts-url.js`) so the vendored bytes match what the previous setup
downloaded. `.vendor-manifest.json` records the source URL and byte size of
each file.

| File | Family | Weights | Size |
|---|---|---|---|
| `geist-latin.woff2` | Geist | 100-900 variable | 29 KB |
| `geist-mono-latin.woff2` | Geist Mono | 100-900 variable | 23 KB |
| `source-serif-4-latin.woff2` | Source Serif 4 | 200-900 variable | 50 KB |
| `days-one-latin.woff2` | Days One | 400 | 15 KB |

Total 116 KB.

Text outside that latin range (Cyrillic, Greek, Vietnamese) falls through to the
platform stacks in `app/_lib/theme.css`. The `unicode-range` declaration in
`index.ts` is what makes that fallback happen instead of tofu.

## Licenses

All four families are under the SIL Open Font License 1.1. The license text as
published with each family is committed next to the font file:

| Family | License file | Source |
|---|---|---|
| Geist | `geist-OFL.txt` | https://github.com/google/fonts/tree/main/ofl/geist |
| Geist Mono | `geist-mono-OFL.txt` | https://github.com/google/fonts/tree/main/ofl/geistmono |
| Days One | `days-one-OFL.txt` | https://github.com/google/fonts/tree/main/ofl/daysone |
| Source Serif 4 | `source-serif-4-OFL.txt` | https://github.com/google/fonts/tree/main/ofl/sourceserif4 |

The OFL permits bundling and redistribution as part of a larger work, with the
license included. That is what this directory does.

## Updating a face

1. Run the vendoring step against Google's CSS2 API with a modern browser
   user-agent so it serves woff2, and keep `.vendor-manifest.json` in step.
2. Replace the woff2 and re-check `unicode-range` and the weight range in
   `index.ts` against the new CSS response.
3. Refresh the license text if the family's version changed.

Do not switch a family back to `next/font/google` to "just get the latest" —
that is the failure this directory exists to prevent.
