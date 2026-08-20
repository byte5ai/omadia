# plugin-ui-proof

The throwaway SPA that proves the epic #470 C8 contract end to end. It is a
test fixture, not a shipped plugin — `pluginUiProof.test.ts` zips it, pushes it
through `PackageUploadService.ingest`, mounts the resulting package on a real
Express app and fetches it back.

What it demonstrates, in one artifact:

| Claim | How the fixture shows it |
|---|---|
| A plugin can ship a multi-file SPA | `ui/index.html` + `ui/assets/app-7c1f4b2e.js` survive the ZIP allowlist |
| A plugin ships no CSS | there is no `.css` file; the HTML links `/bot-api/_harness/plugin-ui.css` |
| A plugin *cannot* ship CSS | the test re-zips with `ui/theme.css` and asserts `zip.forbidden_extension` |
| Hashed assets are cached immutably | `app-7c1f4b2e.js` comes back `max-age=31536000, immutable`; `index.html` does not |
| Arbitrary values are rejected | the test re-zips with `w-[137px]` and asserts `package.ui_arbitrary_tailwind_value` |
| The theme crosses the iframe | the inline bootstrap mirrors `?theme=&palette=&locale=` onto `<html>` |

The JS is hand-written in the shape a Vite build emits — hashed basename, ESM,
class names surviving as plain string literals — because the ingest scanner
sees compiled bundles, never JSX, and a fixture that ignored that would prove
the wrong thing.
