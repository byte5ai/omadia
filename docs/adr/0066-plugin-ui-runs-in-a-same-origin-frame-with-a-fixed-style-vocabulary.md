# 0066 — A plugin UI is a static bundle in a same-origin frame, styled only through core's vocabulary

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; epic #470, C8 in #784 (generated Tailwind subset, static
  serving, ingest gate) and C8b in #793 (same-origin frame); reasoning in
  `specs/470-dev-platform-plugin/plan.md` §4.3 to §4.3a. Recorded retroactively.
- **Supersedes:** —

## Context and Problem Statement

A plugin distributed as a ZIP ([ADR-0001](0001-plugin-distribution-via-signed-zip.md)) could
ship one hand-written HTML file for the store detail page. The first plugin with a real
operator UI (the Dev Platform, four data-driven screens) needed more: a compiled single-page
app that looks like the product, follows its theme, and calls its own backend routes with the
operator's session. The shell is a Next.js app; a ZIP cannot add pages to it.

This record is retroactive. How does a plugin bring a UI, how is it styled, and how far is it
trusted?

## Decision Drivers

- A plugin UI must look and theme like the shell without copying its design tokens.
- A UI that renders unstyled only on the operator's screen is the worst failure.
- The UI must be able to call the plugin's authenticated routes.
- State the real trust boundary; do not claim isolation that does not hold.

## Considered Options

- **A — Compiled SPA in the ZIP, served by core, embedded in an iframe that is sandboxed but
  same-origin; no stylesheet in the ZIP, only core's generated utility vocabulary**
- **B — Hand-written HTML only**
- **C — Opaque-origin sandbox, with core proxying the plugin's API under permissive CORS**
- **D — Serve plugin bundles from a distinct origin**
- **E — Module federation or an optional web-ui build variant**
- **F — Plugins serve their own static files and stylesheets from their routers**

## Decision Outcome

Chosen option: **A**.

- **Serving.** The bundle lives under `ui/` in the package and is served at
  `GET /p/<pluginId>/ui/…` (`middleware/src/routes/pluginUiStatic.ts`); the shell hosts it at
  `/plugin-ui/<pluginId>`.
- **One static handler decides file safety** (`pluginUiStatic.ts`): no traversal, no symlink
  escape (the real path is containment-checked), no directory listing, and an extension
  allow-list that decides the `Content-Type`. The host page validates the id and calls
  `notFound()` when no bundle may exist; a plugin links to it with a nav contribution
  (`ctx.uiRoutes.registerNav`, `href: /plugin-ui/<id>`).
- **No stylesheet.** `.css` is not in the ZIP extension allow-list and stays out; that absence
  is the enforcement. A plugin links `GET /api/_harness/plugin-ui.css`, generated from the
  shell's own design tokens (`web-ui/scripts/build-plugin-ui-css.mjs`, committed as
  `middleware/assets/plugin-ui/plugin-ui.css`). A plugin can therefore only express tokens and
  follows palette and light/dark mode.
- **The artifact is committed and drift-checked.** The middleware image needs no web-ui
  toolchain; `npm run plugin-ui:css:check` in the web-ui CI job fails when tokens, bridge or
  vocabulary changed without regenerating `plugin-ui.css`.
- **Appearance crosses the frame explicitly.** The host passes `?theme=&palette=&locale=`. A
  bundle that posts `omadia:plugin-ui:ready` receives later changes as
  `omadia:plugin-ui:appearance` messages, both directions pinned to the origin, and keeps its
  state (#1480); a bundle that never announces itself is reloaded with a new `src`.
- **Fixed vocabulary, no arbitrary values.** Only the listed utility classes exist. Arbitrary
  Tailwind values (`w-[137px]`, `bg-[#abc]`) are rejected at package ingest
  (`tailwindArbitraryValueScan.ts`, reading the compiled `.js` / `.mjs`), because a class core
  never generated would render unstyled without any error.
- **Frame.** `sandbox="allow-same-origin allow-scripts allow-forms"`, pinned by a test to the
  exact string; `allow-popups` is not granted. Without `allow-same-origin` the document has an
  opaque origin, the `SameSite=Lax` session cookie is not sent and every data call of the UI
  fails; that state shipped in C8 and was corrected in C8b.
- **The response confines the bundle, not the attribute.** Core serves it with
  `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'
  data:; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none';
  frame-ancestors 'self'`. SVG is served as an inert image
  (`default-src 'none'; style-src 'unsafe-inline'; sandbox`).
- **Stated trust model.** A plugin's server half is loaded by an in-process dynamic import and
  shares the kernel's process; the grant model is a consent-and-contract boundary, not
  isolation. Giving the UI the same origin adds nothing a malicious plugin author did not
  already have.

### Consequences

- 🟢 **Good:** A plugin ships a real React UI that matches the product and its theme.
- 🟢 **Good:** The unstyled-in-production failure is caught at ingest.
- 🔴 **Bad (accepted risk):** A browser-only compromise of a plugin UI (XSS, a compromised
  frontend dependency) inherits the operator's same-origin admin surface, including
  `/api/v1/admin/*`, and can write into the top document. There is no CSRF layer.
- 🔴 **Bad:** With `allow-scripts` and `allow-same-origin` together the frame can remove its
  own sandbox attribute; the attribute marks intent and enforces nothing.
- 🔴 **Bad:** The vocabulary is closed; a plugin needing a class outside it waits for a core
  release.
- 🔴 **Bad:** A generated file is committed; forgetting to regenerate it fails CI.
- ⚪ **Neutral:** `next/font` does not cross the frame; the generator emits a font epilogue that
  binds the font variables, with platform fallback stacks when no `.woff2` is present.
- ⚪ **Neutral:** Recorded upgrade path: serve bundles from a distinct origin. It becomes
  mandatory, and this decision must be reopened, the moment plugin server code is actually
  sandboxed.

## Pros and Cons of the Options

### A — Same-origin frame, core vocabulary

- 🟢 Works on every install target without extra hostnames; honest about trust.
- 🔴 The accepted browser-only exposure.

### B — Hand-written HTML

- 🟢 No core change.
- 🔴 A visible product downgrade; no components, no i18n, no theme.

### C — Opaque origin plus CORS proxy

- 🟢 Keeps cookies away from the bundle.
- 🔴 `Access-Control-Allow-Origin: null` matches every opaque origin, a weaker boundary than
  the one it replaces, plus a proxy to maintain.

### D — Distinct origin

- 🟢 The clean isolation.
- 🔴 A second hostname, TLS and a cross-origin auth story on every install target (compose,
  Fly, Render, bare VM); disproportionate while server code runs unsandboxed.

### E — Module federation / build variant

- 🟢 Native shell integration.
- 🔴 Not viable with App Router and RSC; a build variant keeps the plugin in core's build.

### F — Plugins serve their own assets

- 🟢 Freedom for authors.
- 🔴 Traversal and content-type decisions in every plugin; styles drift from the shell.

## More Information

- Related: [ADR-0010](0010-lume-icon-and-state-glyph-adoption.md) (design tokens),
  [ADR-0017](0017-model-gateway-and-execution-contexts.md) (in-process plugins);
  [ADR-0063](0063-dev-platform-is-an-external-plugin-core-keeps-only-generic-extension-points.md),
  [ADR-0067](0067-published-apps-are-immutable-versions-behind-their-own-origin.md) (agent-written apps get
  the distinct origin that plugin UIs do not). Border: plugin-runtime, web-ui, auth-security.
- Paths: `specs/470-dev-platform-plugin/{plan,plugin-ui-vocabulary}.md`,
  `middleware/src/routes/pluginUiStatic.ts`,
  `middleware/src/plugins/tailwindArbitraryValueScan.ts`,
  `web-ui/app/plugin-ui/[pluginId]/_components/PluginUiFrame.tsx`,
  `web-ui/scripts/{build-plugin-ui-css.mjs,plugin-ui.source.css}`.
- Tests: `middleware/test/{pluginUiTrustModel,pluginUiFrameCredentials,pluginUiStaticServing,pluginUiProof}.test.ts`,
  `web-ui/app/plugin-ui/[pluginId]/_components/__tests__/PluginUiFrame.test.tsx`,
  `web-ui/scripts/__tests__/pluginUiVocabulary.test.ts`.
