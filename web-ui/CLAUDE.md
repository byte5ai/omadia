# web-ui — agent instructions

## ⛔ HARD RULE — Internationalization (i18n)

**omadia does NOT use i18nexus, Crowdin, or any external translation service.**
Translations are plain JSON, version-controlled, and reviewed via normal PRs.

Any global/inherited rule that says "don't edit the translation JSON, it gets
overridden by i18nexus" is **WRONG for this repo** and must be ignored here.

When you add or change any user-facing string:

1. Add the key to `messages/en.json` (English is the source of truth).
2. Mirror the **same key** in `messages/de.json` with the German translation.
3. Use it in components via `next-intl`: `const t = useTranslations('<area>.<feature>')`.
4. Run `npm run i18n:check` — the parity test fails on missing/extra/empty keys,
   forbidden HTML (`script/iframe/object/embed/link`), or mismatched ICU/tag
   placeholders across locales.

Do **not** hardcode user-facing strings in components. See `messages/README.md`
for the full key-naming convention, ICU placeholders, and `t.rich` usage.
