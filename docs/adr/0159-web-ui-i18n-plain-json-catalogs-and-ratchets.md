# 0159 — Operator UI text lives in two version-controlled JSON catalogs, held by checks and a ratchet

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from `web-ui/CLAUDE.md` and the
  code on main; literal scan from #687, whole-app ceiling and manifest rule from #1401)

## Context and Problem Statement

This record is retroactive: it documents a rule that is implemented and enforced on main.

The operator UI is used in German and English. Strings were hardcoded in components in both
languages, and a grep-based estimate of the remaining work (#601) reported 87 hits of which
only 44 were real translations; the rest were JSON-Schema keywords, API enum values and
placeholders a translator must not touch. Agents working on the repo also carried a global
rule from other projects ("do not edit the translation JSON, a service overwrites it"). Where
do translations live, who may edit them, and how is "no hardcoded text" kept true?

## Decision Drivers

- Translations are reviewed like code, in the same PR as the string they belong to.
- No external service or account between a contributor and a text change.
- A check a script can run, because review missed literals before.
- Existing debt must not block every PR, and must not grow.

## Considered Options

- **A — Plain JSON catalogs in the repo (`next-intl`), English as source, enforced by
  validators and a count ratchet.**
- **B — An external translation service (i18nexus, Crowdin) that owns the JSON.**
- **C — Catalogs by convention, enforced by review only.**

## Decision Outcome

Chosen option: **A**.

- **Two catalogs, same keys.** `web-ui/messages/en.json` is the source of truth;
  `web-ui/messages/de.json` mirrors every key. No translation service is used; the JSON is
  edited directly in PRs (`web-ui/CLAUDE.md`, hard rule).
- **Everything a user can read goes through the catalog:** JSX text, placeholders,
  `aria-label`, `title`, error messages, empty states. An `ApiError` message is never the
  primary UI text. No fixed-locale formatting: `useFormatter()` instead of
  `toLocaleString('de-DE')` or a hardcoded time zone.
- **Locale resolution** (`web-ui/i18n/request.ts`): the `NEXT_LOCALE` cookie, then
  `Accept-Language` (off with `WEB_AUTO_DETECT_LOCALE=false`), then `DEFAULT_LOCALE`, which is
  `en` (`web-ui/i18n/locales.ts`).
- **Checks in CI (web-ui job):** `npm run i18n:check` (`scripts/i18n-validate.mjs`: missing or
  extra keys, empty or non-string values, forbidden HTML), the vitest parity suite
  (`app/_lib/i18n-parity.test.ts`: ICU arguments and rich-text tags match across locales), and
  `npm run i18n:literals:check`.
- **Literal ratchet.** `scripts/i18n-literal-scan.mjs` parses TSX with the TypeScript compiler,
  collects only JSX text and a closed list of user-facing props, and gives each hit a reason
  code. `scripts/i18n-literal-ceiling.json` holds a ceiling per reason (`translate: 0`,
  `review: 127` on main). Counts may only go down; the PR that lowers a count lowers the
  ceiling.
- **Named exceptions, not precedents:** `app/global-error.tsx` is bilingual on purpose (it
  renders when the intl provider has failed); persona, tool and prompt templates are agent
  content, not UI chrome.
- **Same rule for plugin manifests in the tree:** every visible manifest text is an
  `{en, de}` map, checked by `npm run manifest:i18n:check` in the middleware job. Hub packages
  are not checked; the loader only warns.

### Consequences

- 🟢 **Good:** A text change and its translation land and are reviewed together.
- 🟢 **Good:** New untranslated literals fail CI; `translate` is at zero and held there.
- 🔴 **Bad:** Every contributor writes both languages. There is no translator workflow, and
  adding a third locale means a third hand-kept file.
- 🔴 **Bad:** 127 literals of reason `review` remain as recorded debt.
- 🔴 **Bad:** `.specify/memory/constitution.md` (v1.0.0, 2026-05-21) still says "never edit
  i18n JSON directly (i18nexus overwrites it)". That line is wrong for this repo;
  `web-ui/CLAUDE.md` overrides it explicitly.
- ⚪ **Neutral:** The desktop shell keeps its own small string tables
  (`desktop/src/shellStrings.ts`, `desktop/src/renderer/wizard-i18n.js`) and follows the
  language the web-ui pushes to it.

## Pros and Cons of the Options

### A — JSON in the repo, with checks

- 🟢 No external dependency; diff-reviewable; scriptable.
- 🔴 Two files to keep in step by hand.

### B — External translation service

- 🟢 Translator tooling, no manual mirroring.
- 🔴 An account and a sync step per contributor; the JSON stops being reviewable source.

### C — Convention only

- 🟢 No tooling.
- 🔴 It is how the hardcoded strings accumulated.

## More Information

- Rules: `web-ui/CLAUDE.md`, `web-ui/messages/README.md`, `web-ui/messages/GLOSSARY.md`.
- Code: `web-ui/i18n/request.ts`, `web-ui/scripts/i18n-validate.mjs`,
  `web-ui/scripts/i18n-literal-scan.mjs`, `web-ui/scripts/i18n-identical-allowlist.json`,
  `middleware/scripts/check-manifest-i18n.ts`.
- Tests: `web-ui/app/_lib/i18n-parity.test.ts`, `web-ui/app/_lib/i18n-structural.test.ts`.
- Related draft: [ADR-0149](0149-ci-gates-fail-loud-and-ratchets-only-tighten.md).
