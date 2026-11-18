# SEO Analyst Agent

Analysiert byte5-eigene Webseiten aus SEO-Sicht. Erster "echter" Agent im neuen Package-Format — dient gleichzeitig als **Referenz-Implementation für den Zip-Upload-Flow**.

## Warum dieser Agent zuerst?

- **Keine Secrets.** Arbeitet auf öffentlich erreichbaren Seiten, kein OAuth, kein API-Token.
- **Zero peer-deps.** Nutzt nur `zod` (schon im Host) + native `fetch` + Regex-HTML-Extraktor. Kein `cheerio`, kein Headless-Browser.
- **Deterministisch.** Gleicher HTML-Input → gleicher Report + Score.
- **Klein, aber realistisch.** Drei echte Tools, strukturierte Outputs, Issue-Liste mit Severity, Score mit Rubrik.

## Tools

| Tool | Zweck |
|---|---|
| `analyze_page(url)` | On-Page-Report für eine einzelne URL: Meta, Headings, Links, Bilder, JSON-LD, Issues, Score. |
| `check_technical_seo(base_url?)` | robots.txt, Sitemaps, HTTPS, Security-Header. |
| `audit_site(start_url?, max_pages?, max_depth?)` | BFS-Crawl innerhalb derselben Host, aggregiert On-Page-Issues über alle Seiten. |

Unset `base_url` / `start_url` → Fallback auf `target_base_url` aus dem Install-Setup (Default `https://omadia.ai`).

## Setup-Felder

Alle im Manifest unter `setup.fields` — keine Secrets:

- `target_base_url` (required, default `https://omadia.ai`)
- `user_agent` (optional, default `byte5-seo-bot/0.1 …`)
- `crawl_max_pages` (optional, default 25, hard cap 100)
- `crawl_max_depth` (optional, default 3, hard cap 5)
- `request_timeout_ms` (optional, default 15000)

## Verzeichnis-Layout

```
middleware/packages/agent-seo-analyst/
├── manifest.yaml ─────────────► docs/harness-platform/examples/agent-seo-analyst.manifest.yaml
├── package.json
├── plugin.ts              # activate(ctx) → AgentHandle
├── toolkit.ts             # ToolDescriptor[] + createToolkit()
├── fetcher.ts             # native fetch + regex HTML-Extractor
├── types.ts               # Report-Typen
├── index.ts               # öffentliche Exports
├── analyzers/
│   ├── onPage.ts          # Meta/Headings/Links/Images/JSON-LD → Issues
│   ├── technical.ts       # robots.txt + sitemap.xml + Header
│   ├── crawler.ts         # BFS site-audit
│   └── scoring.ts         # Score-Rubrik (Page + Technical + Site)
└── skills/
    ├── seo-expert.md      # Rolle + Analyse-Rahmen für den LLM
    └── scoring-rubric.md  # Score-Herleitung zum Erklären
```

## Stolperfallen

- **Regex-HTML-Extractor** ist bewusst minimal. Für Selektoren / DOM-Traversierung wäre `cheerio` oder `linkedom` nötig → bewusst weggelassen, damit das Package keine neue peerDep einschleppt. Für SEO-relevante Tags (`<meta>`, `<title>`, Headings, Anchors, Images, JSON-LD-Scripts) reicht es.
- **Kein JavaScript-Rendering.** SPAs, die erst client-side Content rendern, zeigen für diesen Agent kein Inhalt. Für solche Seiten braucht es eine Playwright-Variante (Phase 2).
- **Self-Test** ist ein GET auf `target_base_url` mit eigenem Timeout von höchstens 5 s (unabhängig von `request_timeout_ms`, deutlich unter dem 10-s-Aktivierungsbudget der Runtime). Nur eine Sperre durch Audit-Modus oder Allow-List verhindert die Aktivierung, denn die muss der Operator in der Konfiguration ändern. Ist das Ziel nur nicht erreichbar (kein Internet beim Boot, Egress-Firewall), aktiviert der Agent trotzdem und loggt eine Warnung (#1351).
- **Kein Report ohne Antwort.** `analyze_page`, `check_technical_seo` und `audit_site` schlagen fehl, wenn die angefragte URL (bzw. Root- oder Start-URL) gesperrt oder nicht erreichbar ist. Der Fehler heißt `ToolRefusalError`; ab plugin-api 1.28.0 bekommt das Modell seine Meldung zu lesen statt des zurückgehaltenen Fehlerhinweises (#1343, #1344). Ein gesperrter Folge-Abruf (robots.txt, eine Sitemap auf einem anderen Host) erscheint als Issue `fetch.blocked`, nicht als `…missing`.
- **Crawl-Budget** ist hart begrenzt (100 Seiten / Tiefe 5). Kein versehentlicher Vollcrawl der Domain möglich.

## Zip-Build

```bash
node middleware/scripts/build-seo-analyst-zip.mjs
# → out/seo-analyst-0.2.0.zip
# → out/seo-analyst-package/  (Staging, zur Inspektion)
```

Was drin ist:

```
seo-analyst-0.2.0.zip
├── manifest.yaml          # aus dem Package-Root (nicht mehr docs/examples/)
├── package.json
├── README.md
├── dist/
│   ├── plugin.js          # entry — from lifecycle.entry
│   ├── toolkit.js
│   ├── fetcher.js
│   ├── types.js
│   ├── index.js
│   └── analyzers/*.js
└── skills/
    ├── seo-expert.md
    └── scoring-rubric.md
```

Das Build-Script nutzt die package-lokale `tsconfig.json` (keine Querverweise ins
middleware-Tree — das Zip ist standalone). `PluginContext` ist in `types.ts`
strukturell dupliziert, damit der Agent ohne Import aus `middleware/src/platform`
auskommt.

## PluginContext surface — v1.0 readiness audit (#431)

| Surface | Decision | Rationale |
|---|---|---|
| `ctx.jobs` | deferred adopt | Long `audit_site` crawls are the natural fit (background job + progress). Deliberately **not** adopted in the #431 polish pass — moving the crawl into a job changes the tool's response contract; tracked as a follow-up, not a readiness blocker. Crawl budget stays hard-capped (100 pages / depth 5) meanwhile. |
| `ctx.status` | skip | No credentials or external connection to report; the activate-time self-test only refuses a blocked target; reachability is checked per tool call. |
| `ctx.llm` | skip | The host LLM drives agent turns; the analyzers are deliberately deterministic (same HTML → same score). |
| `ctx.mcp` | skip for 1.0 | Outbound fetches route through `ctx.http` with zero configuration — the plugin's design goal. Reaching external SEO tooling via a granted MCP server is a possible extension, not a readiness item. |

Versioning: stays independently versioned (currently `0.2.0`); does not bump
in lockstep with core. Package layout stays the flat agent-package shape —
canonical per `agent-reference-maximum` (the declared pattern source) and the
`middleware/assets/boilerplate/agent-*` starter templates; tool plugins use
`src/` → `dist/`. Both shapes are the documented per-kind conventions.
