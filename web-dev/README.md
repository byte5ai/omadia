# `web-dev/` — Local Next.js dev UI for the Omadia middleware

Lightweight Next.js 15 + React 19 app that renders the chat surface, the plugin store, the builder, and the admin panels on top of the middleware's `/api/v1/*` HTTP API. **Not for production exposure** — auth is cookie-based and assumes a trusted single-tenant deployment.

## Quick start

```bash
nvm use         # Node 22.x — see .nvmrc at repo root
npm install
npm run dev     # http://localhost:3300
```

Requires the middleware running on `http://localhost:3979` (set `MIDDLEWARE_URL` to override). `/bot-api/*` requests on this Next server are rewritten to `/api/*` on the middleware so the browser only ever sees same-origin calls.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Dev server on port 3300 |
| `npm run lint` / `lint:fix` | ESLint check / auto-fix |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest single-run (incl. i18n parity test) |
| `npm run test:watch` | Vitest watch mode |
| `npm run i18n:check` | Validate translation key parity across locales |

## Languages

The UI is bilingual: **English (default) and German**. Locale is resolved per request (`i18n/request.ts`):

1. **`NEXT_LOCALE` cookie** — set by the in-app language switcher (top-right of the header). Wins over the browser hint.
2. **Browser `Accept-Language` header** — auto-detected with RFC 7231 q-value sorting; the highest-priority supported tag wins. Set `WEB_AUTO_DETECT_LOCALE=false` to disable.
3. **`DEFAULT_LOCALE`** — final fallback, currently `'en'`.

To add a translation, edit `messages/en.json` (source of truth) and `messages/de.json` in the same PR, then run `npm run i18n:check`. The full convention guide lives at [`messages/README.md`](./messages/README.md).

## Project layout

```
app/                   Next.js App Router pages + components
  _components/         Shared UI components (Nav, AuthBadge, LocaleSwitcher, …)
  _lib/                Pure helpers (api client, types, test-utils)
  page.tsx             Landing/chat
  login/               Auth flow
  setup/               First-user wizard
  store/               Plugin store + builder
  admin/               Admin panels
  routines/            Scheduled-task surface
  system/              Health + diagnostics
  memory/              Operator memory browser
  graph/               Knowledge-graph viewer
i18n/                  Locale config + per-request resolution
messages/              Translation JSON (en, de) + convention doc
scripts/i18n-validate.mjs  CI-runnable parity gate
middleware.ts          Auth-cookie gate
next.config.ts         Build config + next-intl plugin wiring
```

## Tests

Vitest (`jsdom`) covers the pure helpers and a small set of React-Testing-Library smokes for the chat-side cards and builder forms. Tests for components that call `useTranslations()` need the `renderWithIntl` helper from `app/_lib/test-utils.tsx`.

## Contributing translations

1. Add the new key to `messages/en.json` first (source of truth).
2. Mirror it in `messages/de.json` with the German translation.
3. Run `npm run i18n:check` and `npm test` — both pass.
4. Open a PR; the maintainer reviews wording and merges.

See [`messages/README.md`](./messages/README.md) for the full convention guide (key naming, ICU placeholders, JSX placeholders, plurals, helper-function patterns, test wrappers, tech-string exceptions).
