# SEO Analyst Agent

Public-website SEO analyser. Reference implementation for the plugin
package format and the ZIP-upload flow.

## Why this agent as a reference

- **No secrets.** Works on publicly reachable URLs — no OAuth, no API tokens.
- **Zero peer-deps.** Uses only `zod` (already in the host) + native `fetch`
  + a regex-based HTML extractor. No `cheerio`, no headless browser.
- **Deterministic.** Same HTML input → same report + score.
- **Small but realistic.** Three real tools, structured outputs, an issue
  list with severity, score with rubric.

## Tools

| Tool | Purpose |
|---|---|
| `analyze_page(url)` | On-page report for a single URL: meta, headings, links, images, JSON-LD, issues, score. |
| `check_technical_seo(base_url?)` | robots.txt, sitemaps, HTTPS, security headers. |
| `audit_site(start_url?, max_pages?, max_depth?)` | BFS crawl within the same host, aggregates on-page issues across pages. |

Unset `base_url` / `start_url` → falls back to `target_base_url` from the
install setup.

## Setup fields

All declared in the manifest under `setup.fields` — no secrets:

- `target_base_url` (required) — root URL the agent analyses
- `user_agent` (optional) — bot identifier sent on each fetch
- `crawl_max_pages` (optional, default 25, hard cap 100)
- `crawl_max_depth` (optional, default 3, hard cap 5)
- `request_timeout_ms` (optional, default 15000)

## Directory layout

```
middleware/packages/agent-seo-analyst/
├── manifest.yaml
├── package.json
├── plugin.ts              # activate(ctx) → AgentHandle
├── toolkit.ts             # ToolDescriptor[] + createToolkit()
├── fetcher.ts             # native fetch + regex HTML extractor
├── types.ts               # report types
├── index.ts               # public exports
├── analyzers/
│   ├── onPage.ts          # meta/headings/links/images/JSON-LD → issues
│   ├── technical.ts       # robots.txt + sitemap.xml + headers
│   ├── crawler.ts         # BFS site audit
│   └── scoring.ts         # score rubric (page + technical + site)
└── skills/
    ├── seo-expert.md      # role + analysis framing for the LLM
    └── scoring-rubric.md  # how the score is derived (explainability)
```

## Gotchas

- **The regex HTML extractor is intentionally minimal.** Selector / DOM
  traversal would need `cheerio` or `linkedom` — explicitly omitted so the
  package introduces no new peer-dep. SEO-relevant tags (`<meta>`,
  `<title>`, headings, anchors, images, JSON-LD scripts) work fine.
- **No JavaScript rendering.** SPAs that render content client-side are
  invisible to this agent. For those, a Playwright variant is required.
- **The self-test is a GET on `target_base_url` with a short timeout.**
  If it fails, the agent does not activate.
- **The crawl budget is hard-capped** (100 pages / depth 5). No accidental
  full-domain crawl is possible.

## ZIP build

```bash
node middleware/scripts/build-seo-analyst-zip.mjs
# → out/seo-analyst-0.1.0.zip
# → out/seo-analyst-package/  (staging, for inspection)
```

What's inside:

```
seo-analyst-0.1.0.zip
├── manifest.yaml
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

The build script uses the package-local `tsconfig.json` (no cross-references
into the middleware tree — the ZIP is standalone). `PluginContext` is
duplicated structurally in `types.ts` so the agent doesn't need to import
from `middleware/src/platform`.
