# Translations (`messages/`)

> ## ⛔ HARD RULE
> **omadia does NOT use i18nexus / Crowdin / any external translation service.**
> Add new strings **directly** to `en.json` + `de.json` and commit them. Any
> inherited rule claiming the JSON "gets overridden by i18nexus" is wrong here —
> ignore it. Never hardcode user-facing strings in components.

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

## Error-help copy (`errorHelp.<code>`)

The middleware has no request locale — every `message` it puts on an error
envelope is English by construction. `errorHelp` is the catalogue that turns
its machine-readable `code` into copy the operator can read, so the server's own
sentence never has to be the primary text on screen.

One entry per middleware error code, keyed by the code **verbatim**, dots and
all. This is the one deliberate exception to the `<area>.<feature>.<element>`
convention above: the key has to be reachable as
``t(`errorHelp.${code}`)`` from a code the server chose at runtime.

```jsonc
{
  "errorHelp": {
    "runtime": {
      "vault_unavailable": {
        "what": "The secret store is not reachable from the middleware right now.",
        "next": "Check the vault configuration, then save again.",
        "action": "Open the store"   // OPTIONAL — see below
      }
    }
  }
}
```

- **`what`** — one sentence, past tense, what happened. Not the cause, not a
  stack trace, not the code itself.
- **`next`** — one imperative sentence, the single action that resolves it.
  If there is genuinely nothing to do, say what to expect instead.
- **`action`** — the label for a link to the page that carries out `next`.
  Add it **only** when the code also appears in `ERROR_HELP_ACTIONS` in
  `app/_lib/errorHelp.ts`, which holds the route; a label with no route
  renders nothing, and a route with no label renders an unlabelled link.

Both locales are written in the same voice as the rest of the catalogue: second
person, no exclamation marks, no "Oops", no apology, and no interpolated
identifiers — the raw code and the server's message belong in the collapsed
"details for support" disclosure, not in `what` or `next`.

### Adding a code

1. Add the entry to `en.json`, then mirror it in `de.json` (rule above).
2. Add the code to `ERROR_HELP_CODES` in `app/_lib/errorHelp.ts`, alphabetical
   within its family.
3. Run `npm run test` (or just `npx vitest run app/_lib/__tests__/errorHelpCoverage.test.ts`).

### Why the test suite goes red when the middleware changes

`app/_lib/__tests__/errorHelpCoverage.test.ts` reads the middleware sources
directly and fails on any gap. It covers five route files —
`middleware/src/routes/{install,runtime,adminProviders,store,adminSettings}.ts`
— and only those; the repo emits ~238 codes in total and the catalogue does not
claim the rest.

Inside that scope, the guard fails when:

- a covered file emits a `code: 'x.y'` with no `errorHelp.x.y.what` **and**
  `.next` in **every** locale under `messages/` (locales are discovered, not
  listed — adding `fr.json` immediately puts every code on the hook);
- `errorHelp` holds an entry no covered file emits (an orphan — usually a code
  that was renamed or removed server-side);
- `ERROR_HELP_CODES` and the copy drift apart in either direction;
- a covered file writes a `code:` the extractor cannot read.

That last one is why **adding a `code:` literal to one of those five route
files turns this suite red until you write copy here.** It is deliberate: a code
with no copy behind it degrades to the generic "that failed" line, which is the
state the catalogue exists to end.

It also covers the shape that is *not* a literal. `install.ts`'s `handleError`
answers a thrown `InstallError` with `{ code: err.code }`, so ten `install.*`
codes never appear as a literal in the route file at all; the guard follows that
forwarder into `middleware/src/plugins/installService.ts` and requires copy for
what it finds there too. Any other non-literal `code:` must be registered in
`ACKNOWLEDGED_NON_LITERAL_CODE` with the reason it is not an error code (a type
annotation, an OAuth authorization code), or the guard fails rather than let a
code slip through unexplained.

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
