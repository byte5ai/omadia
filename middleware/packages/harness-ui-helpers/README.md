# `@omadia/plugin-ui-helpers`

> Minimal SSR-Helper, damit Plugins eigenes HTML unter
> `/p/<pluginId>/...` ausliefern können — **ohne** React, **ohne**
> Build-Step, **ohne** Asset-Bundling. Tagged-Template-Literal +
> Tailwind-CDN + iframe-safe CSP.

Plugin-Autoren brauchen drei Dinge:

| Export | Zweck |
|---|---|
| `html` | Tagged Template Literal. Interpolationen werden HTML-escaped (Default-XSS-defense). Verschachtelte `html\`...\`` und `safe(...)` Fragments bleiben unescaped. |
| `htmlDoc({title, body, refreshSeconds?, ...})` | Wraps ein `HtmlFragment` in vollständiges HTML5-Doc mit Tailwind-CDN. `refreshSeconds` triggert `<meta http-equiv="refresh">` — der einfachste „Self-Filling-Tab"-Pfad. |
| `renderRoute(handler)` | Adapter von `(ctx) → HTML-string` zu Express-`RequestHandler`. Setzt iframe-safe CSP-Header (`frame-ancestors *.teams.microsoft.com / *.office.com`) und `X-Content-Type-Options: nosniff`. |

## Minimal-Beispiel

```ts
import { Router } from 'express';
import { html, htmlDoc, renderRoute, safe } from '@omadia/plugin-ui-helpers';

export function createDashboardRouter(opts: { notes: NotesStore }): Router {
  const router = Router();

  router.get(
    '/dashboard',
    renderRoute(async () => {
      const notes = await opts.notes.list();
      return htmlDoc({
        title: 'My Plugin',
        refreshSeconds: 30,          // Self-Filling: auto-reload alle 30s
        body: html`
          <main class="max-w-2xl mx-auto p-6 space-y-4">
            <h1 class="text-2xl font-semibold">Notes (${notes.length})</h1>
            ${notes.length === 0
              ? safe('<p class="text-sm text-slate-500">No notes yet.</p>')
              : html`
                  <ul class="space-y-2">
                    ${notes.map(
                      (n) => html`<li class="border p-2 rounded">${n.body}</li>`,
                    )}
                  </ul>
                `}
          </main>
        `,
      });
    }),
  );

  return router;
}
```

In `activate()`:

```ts
const dashRouter = createDashboardRouter({ notes });
const disposeDash = ctx.routes.register('/p/my-plugin', dashRouter);
ctx.uiRoutes.register({
  routeId: 'dashboard',
  path: '/dashboard',
  title: 'My Plugin — Dashboard',
  order: 50,
});
```

Resultierende URL: `https://<harness>/p/my-plugin/dashboard`.

## XSS-Defense (Default-on)

`html\`\`` behandelt **jede** Interpolation als untrusted Text und HTML-
escaped sie. Beispiel:

```ts
html`<div>${userInput}</div>`
// userInput = '<script>alert(1)</script>'
// → "<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>"
```

Opt-out via `safe(rawHtml)` wenn du nested-fragment-Output einbettest, der
bereits eskapt ist (z.B. von einem anderen `html\`\``-Call):

```ts
const inner = html`<em>bold</em>`;
html`<p>${inner}</p>`            // works — inner ist HtmlFragment, kein String
html`<p>${safe('<em>bold</em>')}</p>`  // explicit opt-out, vorsicht
```

## iframe-Safe CSP

`renderRoute()` setzt automatisch:

```
Content-Security-Policy:
  default-src 'self' https: data: blob:;
  img-src 'self' https: data: blob:;
  style-src 'self' 'unsafe-inline' https:;
  script-src 'self' 'unsafe-inline' https:;
  frame-ancestors 'self'
    https://*.teams.microsoft.com
    https://teams.microsoft.com
    https://*.office.com
    https://*.microsoft365.com
X-Content-Type-Options: nosniff
```

`'unsafe-inline'` in `style-src` ist nötig, weil Tailwind via CDN-Script
JIT-CSS-Klassen zur Laufzeit emittiert. Für Production mit gebautem
Tailwind-Bundle kann man später strikter werden.

## Self-Filling-Tabs

`refreshSeconds: 30` emittiert einen `<meta http-equiv="refresh">`-Tag.
Der Browser reloadet die Seite alle N Sekunden — der SSR-Handler läuft
frisch gegen die aktuelle Datenlage, kein Client-JS nötig.

Reicht für **„zeig mir die neuesten Daten"**-Use-Cases. Für richer
Scenarios (Sub-Sekunde-Updates, Form-Inputs überleben, kein
Scroll-Reset) später Polling-Fetch + DOM-Swap einbauen — aber für eine
MVP-Tab-Surface ist die 1-Zeilen-Lösung perfekt.

## Was NICHT drin ist

- Keine Komponenten-Library (Card, Button, Table) — Plugins composen aus
  Tailwind-Klassen direkt. Wenn ein gemeinsamer Bedarf entsteht: separates
  `@omadia/plugin-ui-components`-Paket dazu.
- Kein Client-Side-State / Reactivity. Pure SSR. Interaktion via Forms
  + Server-Side-Handler.
- Kein i18n. Plugins können das selbst lösen (z.B. `next-intl`-style mit
  einem `t(key)`-Helper aus dem ctx).
- Kein Auth innerhalb des Helpers. Plugin-Routes laufen ohne Session-Cookie
  (siehe `requireAuth` publicPaths in Notion-Doku 14); wer sensible Daten
  ausgibt, validiert den Teams-SSO-Token im eigenen Handler.

## Versionierung

Backwards-compatible Add-ons (neue optionale `htmlDoc`-Option, neuer Export)
sind Patch-Bumps. Breaking changes an der `renderRoute`/`html`-Surface
würden Minor-Bumps. Major bleibt für API-Reshape (z.B. Wechsel auf JSX/React).
