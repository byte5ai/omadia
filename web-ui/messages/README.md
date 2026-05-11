# Translations (`messages/`)

This directory holds plain-JSON translations for the web-ui UI. **No external service** (no i18nexus, no Crowdin) — translations are reviewed and merged via normal pull-request flow.

## Reference locale

**English (`en.json`) is the source of truth and the default locale.** When adding a new string:

1. Add the key first to `en.json`.
2. Mirror the same key in `de.json` with the German translation.
3. Run `npm run i18n:check` (or `npm test` — the parity test runs there too) to verify the key sets match across locales.

The parity check fails if any locale is missing a key, has an extra key, contains an empty value, contains forbidden HTML (`<script>`, `<iframe>`, etc.), or has mismatched ICU placeholder names between locales.

## Locale resolution at runtime

Locale is picked per request in this order (`web-ui/i18n/request.ts`):

1. **`NEXT_LOCALE` cookie** — set by the in-app `<LocaleSwitcher>` when the user picks a language explicitly. Wins over everything.
2. **`Accept-Language` browser header** — auto-detected via RFC 7231 q-value sorting. The first supported tag wins. Disable by setting `WEB_AUTO_DETECT_LOCALE=false` in the environment (e.g. for reproducible test runs or single-language deployments).
3. **`DEFAULT_LOCALE`** in `web-ui/i18n/locales.ts` — final fallback, currently `'en'`.

## Key naming convention

**Dot-hierarchy: `<area>.<feature>.<element>`**

```jsonc
{
  "store": {
    "builder": {
      "installModal": {
        "conflictTitle": "Conflicts detected"
      }
    }
  }
}
```

Use it in components via `next-intl`:

```tsx
import { useTranslations } from 'next-intl';

const t = useTranslations('store.builder.installModal');
return <h2>{t('conflictTitle')}</h2>;
```

Guidelines:

- The first segment matches the page or shared area: `nav`, `layout`, `localeSwitcher`, `login`, `setup`, `admin`, `store`, `system`, `routines`, `memory`, `graph`, `chat`, `chatTabs`, `authBadge`, `agentDetailsModal`, `agentUsagePills`, `nudgeCard`, `privacyReceipt`, `onboarding`.
- Keys are `camelCase`. Avoid sentence-as-key (`"Save changes"`) — wording changes shouldn't break refactors.
- Group by component, not by reading order.
- Don't repeat the area in the leaf (`login.loginButton` ❌ → `login.submit` ✅).

## ICU placeholders

`next-intl` uses [ICU MessageFormat](https://formatjs.io/docs/core-concepts/icu-syntax/). For variables:

```jsonc
{
  "login": {
    "continueWith": "Continue with {provider}"
  }
}
```

```tsx
t('continueWith', { provider: p.displayName });
```

For pluralization:

```jsonc
{
  "agentDetailsModal": {
    "callCount": "{count, plural, one {# call} other {# calls}}"
  }
}
```

```tsx
t('callCount', { count: calls.length });
```

For embedded JSX (e.g. `<code>`):

```jsonc
{ "login": { "noProviders": "Set {envVar} in the middleware environment." } }
```

```tsx
t.rich('noProviders', { envVar: () => <code>AUTH_PROVIDERS</code> });
```

**Placeholder names must match across locales** — the parity test enforces this.

## Helper functions that need to translate

If a helper outside a React component returns a translated string (e.g. `formatLivenessGap` in `app/page.tsx`, the renderers in `PrivacyReceiptCard.tsx`), pass the translator function as a parameter:

```ts
type TFn = (key: string, values?: Record<string, string | number>) => string;

function formatLivenessGap(ms: number, t: TFn): string {
  if (ms < 1000) return t('chat.livenessGapMs', { ms });
  return t('chat.livenessGapSec', { seconds: (ms / 1000).toFixed(1) });
}
```

This keeps helpers unit-testable (pass a fake translator) without coupling them to React's hook rules.

## Tests

Components that call `useTranslations()` need a `<NextIntlClientProvider>` wrapper. Use the `renderWithIntl` helper:

```tsx
import { renderWithIntl } from '../../_lib/test-utils';

renderWithIntl(<MyComponent />);                  // default locale 'en'
renderWithIntl(<MyComponent />, { locale: 'de' }); // for DE-specific assertions
```

Default is `'en'` — pass `locale: 'de'` only when the test asserts German strings.

## How to add a new locale

1. Add the language code to `LOCALES` in `web-ui/i18n/locales.ts` and to `LOCALE_LABELS`.
2. Copy `en.json` to `messages/<locale>.json` and translate values in place.
3. Add the locale to `TARGET_LOCALES` in `web-ui/scripts/i18n-validate.mjs`.
4. Run `npm run i18n:check` and `npm test`.

## Don't

- Don't edit translations outside this directory.
- Don't put HTML markup in translation values (the parity test forbids `<script>`, `<iframe>`, `<object>`, `<embed>`, `<link>`). For embedded JSX, use `t.rich(...)` placeholders.
- Don't use the same string as both key and value (`"Save changes": "Save changes"`).
- Don't translate technical labels that match backend telemetry (e.g. `input`, `output`, `sub-agent trace`, detector status `ok/skipped/timeout/error`). The parity validator will warn but not fail — that's intentional.
