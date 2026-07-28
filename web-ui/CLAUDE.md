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

## String-handling checklist (read before touching any component)

This rule was violated ~860 times before PR #447 swept the codebase clean.
Keep it clean:

1. **No user-facing literals in `.ts`/`.tsx` — in any language.** Everything a
   user can see goes through the catalog: JSX text, placeholders, `aria-label`,
   `title` attributes, toasts, error messages, empty states, badge labels.
2. **German belongs only in `messages/de.json`.** If you are typing German
   words in a component file, stop — add a key instead.
3. **Error messages are user-facing strings too.** Never render a raw
   `ApiError`/exception message as the primary UI text; give it a catalog key
   and put the technical detail behind it.
4. **No hardcoded locale formatting.** No `toLocaleString('de-DE')`, no
   `Intl.*` with a fixed locale, no hardcoded `Europe/Berlin` — use
   next-intl's `useFormatter()` so numbers, dates, and timezones follow the
   active locale.
5. **Self-check your diff before committing** — flag any added string literal
   containing German (umlauts or common words):

   ```bash
   git diff --cached -U0 -- '*.ts' '*.tsx' | grep -E '^\+' \
     | grep -E '[äöüÄÖÜß]|"(Speichern|Abbrechen|Fehler|Keine|Laden|Bitte|Wird)'
   ```

   Hits in comments or the exceptions below are fine; hits in string literals
   are not — convert them before committing.
6. **Deliberate exceptions — do not "fix" them, and do not cite them as
   precedent for new hardcoded strings:**
   - `app/global-error.tsx` — intentionally bilingual; it renders when the
     intl provider itself has failed.
   - `MOCK_KG_WALK` in `app/chat/page.tsx` — dev-only fixture behind `?kgmock=1`.
   - `app/_lib/personaTemplates.ts`, `app/_lib/toolTemplates.ts`,
     `app/_lib/composeFixPrompt.ts` — persona/tool/prompt *content* compiled
     into agents, not UI chrome.
