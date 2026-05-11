# Admin-UI Authoring — Claude Builder Guide

Dieses Dokument beschreibt die **harten Constraints** und das gewünschte
Pattern für den `admin-ui-body`-Slot in `assets/admin-ui/index.html`.
Quelle der Wahrheit für das Baseline-Stylesheet:
`middleware/src/admin-ui/harness-admin-css.ts` (im Browser served via
`/bot-api/_harness/admin-ui.css`).

## Wann dieser Guide greift

Trigger: **jede Bearbeitung** der Marker-Region
`<!-- #region builder:admin-ui-body -->` ... `<!-- #endregion -->` in
`assets/admin-ui/index.html`. Das Boilerplate-Drumherum (head, body-class,
title, link-tag) ist vom Codegen befüllt — daran NICHT herumschreiben.

Das parent CLAUDE.md (`docs/harness-platform/boilerplate/agent-integration/CLAUDE.md`)
erklärt das große "Wie funktioniert die Admin-UI"-Bild. Dieses Dokument
dreht sich ausschließlich um **Layout, Styling und Constraints des
Body-Inhalts**.

---

## 1. Container-Maße — HART

Die Admin-UI rendert in einem Iframe in der Web-Dev-Hostframe-Page
(`/store/<plugin-id>`). Quelle:
`web-ui/app/store/[id]/page.tsx` Layout-Grid + Iframe-Höhe.

| Viewport                        | Iframe-Breite  | Iframe-Höhe   |
| ------------------------------- | -------------- | ------------- |
| Desktop ≥1024 px (Container max) | **812 px**     | 1000 px fix   |
| Tablet 768–1023 px (Stack)       | ~720 px        | 1000 px fix   |
| Mobile ≥320 px                   | ~327 px        | 1000 px fix   |

**MUST:** Inhalte müssen bei **320 px Breite** lesbar + funktional sein.
Über 812 px brauchst du nicht zu denken — der Container limitiert.

**MUST:** plane für maximal **1000 px Höhe**. Inhalte > 1000 px scrollen
iframe-intern (hässliche Doppel-Scrollbar). Lieber Pagination, Collapsible
Sections, oder Tab-Wechsel statt langer Listen.

CSS-Vars im harness-Stylesheet:
- `--harness-iframe-max: 812px` — Desktop-Maximum
- `--harness-iframe-min: 320px` — Mobile-Minimum
- `--harness-iframe-height: 1000px` — feste Höhe

```css
.my-grid { max-width: var(--harness-iframe-max); }
@media (max-width: 600px) { .my-table { font-size: 0.85em; } }
```

---

## 2. Farb-Tokens — NUR diese, KEINE hardcoded Hex

**MUST:** für alle Farbwerte `var(--*)` aus dem Token-Inventar nutzen.
Hardcoded Hex (`#22c55e`, `#ef4444`, `#9ca3af`, etc.) ist **VERBOTEN** —
bricht Dark-Mode + Theme-Updates. Wenn du eine Farbe brauchst die nicht
im Token-Inventar steht, ist das ein Hinweis dass die UI im falschen
Stil entworfen wurde.

### Surface

| Var               | Bedeutung                              |
| ----------------- | -------------------------------------- |
| `--bg`            | Page-Hintergrund                       |
| `--bg-soft`       | Sekundärer Surface (Hover, Header-Row) |
| `--bg-elevated`   | Card-/Input-Hintergrund                |

### Foreground

| Var               | Bedeutung                              |
| ----------------- | -------------------------------------- |
| `--fg`            | Body-Text                              |
| `--fg-strong`     | Headings, hervorgehobener Text         |
| `--fg-muted`      | Sekundärtext (subtitle, caption)       |
| `--fg-subtle`     | Faint text (placeholder, disabled)     |

### Akzent + Status

| Var          | Wann                                          |
| ------------ | --------------------------------------------- |
| `--accent`   | Primary CTA, Focus-Ring, Links                |
| `--success`  | Online-Status, Save-OK-Banner                 |
| `--warning`  | Caution-States                                |
| `--danger`   | Error-States, Delete-Aktionen                 |
| `--info`     | Informational Banner (Alias auf `--accent`)   |

### Lines + Radii

| Var               | Bedeutung                              |
| ----------------- | -------------------------------------- |
| `--border`        | Standard-Border (Inputs, Cards)        |
| `--border-strong` | Hover-/Focus-Border                    |
| `--divider`       | Horizontal-Lines (Tabellenzeilen, hr)  |
| `--radius-xs`     | 4 px (chips, code-tags)                |
| `--radius-sm`     | 8 px (cards, inputs)                   |
| `--radius-md`     | 14 px (große Cards)                    |
| `--radius-pill`   | 9999 px (CTAs)                         |

### Typografie

| Var              | Bedeutung                               |
| ---------------- | --------------------------------------- |
| `--font-text`    | Body — Nunito Sans                      |
| `--font-display` | Headings — Days One                     |
| `--font-mono`    | Code, MAC, Hash, ID — JetBrains Mono    |

`font-family` im eigenen `<style>` setzen ist meistens **falsch** — das
Stylesheet macht das schon. Nur für mono-spezifische Cells (MAC-Adressen,
IDs) explizit `font-family: var(--font-mono)`.

---

## 3. Helper-Klassen (`.harness-*`)

Bevorzugt vor inline-CSS:

| Klasse                    | Wofür                                             |
| ------------------------- | ------------------------------------------------- |
| `.harness-subtitle`       | Beschreibungs-Paragraph unter `<h1>`              |
| `.harness-empty`          | "Noch keine Daten"-Hinweis (italic, muted)        |
| `.harness-btn`            | Sekundärer Button (outline)                       |
| `.harness-btn--primary`   | Primary CTA (filled accent)                       |
| `.harness-input`          | Form-Input (Alias des `<input>`-Baselines)        |
| `.harness-table`          | Tabellen-Reset                                    |
| `.harness-banner-error`   | Roter Inline-Error                                |
| `.harness-banner-info`    | Blauer Inline-Info                                |

Eigene Klassen sind erlaubt für plugin-spezifische Layouts — aber für die
**common cases** zuerst die Helper nutzen, damit der UniFi-Tracker und der
Confluence-Browser nicht jeweils anders aussehen.

---

## 4. Tabellen-Pattern

**MUST bei >4 Spalten:** Tabelle in einen `<div style="overflow-x:auto">`
Wrapper packen. So scrollt die Tabelle horizontal **innerhalb des Iframes**
statt ihn nach rechts zu sprengen (= das UniFi-0.6.0-Problem).

```html
<div style="overflow-x:auto;">
  <table>
    <thead><tr><th>Hostname</th><th>MAC</th><th>Person</th><th>Status</th><th>Aktion</th></tr></thead>
    <tbody>...</tbody>
  </table>
</div>
```

**SHOULD bei >6 Spalten oder dichten Save-Forms:** zusätzlich Card-Layout-
Fallback unter 600 px:

```html
<style>
  @media (max-width: 600px) {
    .responsive-table thead { display: none; }
    .responsive-table tr {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 0.4rem 0.8rem;
      padding: 0.6rem;
      border-bottom: 1px solid var(--divider);
    }
    .responsive-table td::before {
      content: attr(data-label);
      font-weight: 600;
      color: var(--fg-muted);
      text-transform: uppercase;
      font-size: 0.7em;
      letter-spacing: 0.05em;
    }
    .responsive-table td { display: contents; }
  }
</style>
<table class="responsive-table">
  <tbody>
    <tr>
      <td data-label="MAC">aa:bb:cc:dd:ee:ff</td>
      <td data-label="Person">Max Muster</td>
    </tr>
  </tbody>
</table>
```

---

## 5. Form-Controls

**MUST:** `<select>`, `<input>`, `<textarea>` immer **`width: 100%; max-width: 100%`**.
Das Baseline-Stylesheet macht das per default — eigene `max-width: 220px`-
Overrides brechen das Mobile-Layout.

**MUST:** Save-Buttons in Tabellenzeilen unter 600 px als **icon-only oder
kompakter** darstellen, sonst überlappen sie das Select:

```html
<style>
  @media (max-width: 600px) {
    .save-btn { padding: 0.4rem 0.6rem; }
    .save-btn .label { display: none; }
  }
</style>
<button class="harness-btn harness-btn--primary save-btn" type="button">
  <span aria-hidden="true">💾</span><span class="label"> Speichern</span>
</button>
```

**MUST:** `<label>` für jedes Input — auch wenn visuell weggelassen, dann
mit `class="visually-hidden"` (siehe unten) oder `aria-label`.

```css
.visually-hidden {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0,0,0,0);
  white-space: nowrap; border: 0;
}
```

---

## 6. Banner & States

```html
<!-- Error: -->
<div class="harness-banner-error" role="alert">
  Speichern fehlgeschlagen: API antwortet nicht.
</div>

<!-- Info: -->
<div class="harness-banner-info" role="status">
  3 von 25 Geräten zugeordnet.
</div>

<!-- Empty-State: -->
<p class="harness-empty">Noch keine Geräte erfasst.</p>
```

**MUST:** error- und status-Container haben `role="alert"` bzw.
`role="status"` für Screenreader. Das `hidden`-Attribut zum Aus-/Einblenden
nutzen — kein `style="display:none"`-Hin-und-Her im JS.

---

## 7. Verbotene Patterns

- ❌ **`position: fixed` / `position: sticky`** — bricht im Iframe-Kontext
  visuell und scrollt nicht wie erwartet. Stattdessen normalen Flow.
- ❌ **Absolute fetch-URLs ohne `/bot-api/`-Prefix** — siehe parent
  CLAUDE.md, Baustein 1 KRITISCH-Box. Immer relativ:
  `fetch('api/devices')` ✓, `fetch('/api/<slug>/api/devices')` ✗.
- ❌ **Externe Webfonts** (`@import` aus Google Fonts, fonts.com, etc.) —
  CSP-Risiko + extra Roundtrip + Layout-Shift. Das Stylesheet liefert
  `--font-text` / `--font-display` / `--font-mono`.
- ❌ **Hardcoded Hex statt Tokens** — `color: #22c55e` → `color: var(--success)`.
- ❌ **Inline-`max-width` auf `<body>` oder `<html>`** — der Stylesheet
  sized den Body bereits korrekt; eigene Overrides brechen das Layout.
- ❌ **`<style>` im `<head>`** außerhalb des Marker-Slots — dort gehört
  nur das harness-Stylesheet-Link rein. Eigene Styles inline im body-slot
  als `<style>` direkt nach der Region-Marker-Zeile.
- ❌ **Top-Level `<script src="...">`** für externe Libs (jQuery, lodash,
  Chart.js, etc.) — single-file ist die unterstützte Form.

---

## 8. Vollständiges Beispiel-Skelett (responsiv, accessible, conform)

```html
<!-- #region builder:admin-ui-body -->
<style>
  /* Page-spezifische Layout-Regeln; Tokens + Baselines kommen aus dem Stylesheet. */
  #toolbar { display: flex; gap: 0.5rem; margin-bottom: 1rem; align-items: center; }
  #toolbar input { flex: 1; min-width: 0; }
  #counter { color: var(--fg-muted); font-size: 0.85em; margin-top: 0.5rem; }

  @media (max-width: 600px) {
    #toolbar { flex-direction: column; align-items: stretch; }
  }
</style>

<div id="global-err" class="harness-banner-error" role="alert" hidden></div>

<div id="toolbar">
  <label class="visually-hidden" for="q">Filter</label>
  <input id="q" type="search" placeholder="Nach Hostname oder MAC filtern…" />
  <button class="harness-btn" type="button" onclick="loadAll()">
    Aktualisieren
  </button>
</div>

<p id="loading" class="harness-empty">Lade Daten…</p>

<div id="table-wrap" hidden>
  <div style="overflow-x:auto;">
    <table>
      <thead>
        <tr>
          <th>Status</th>
          <th>Hostname</th>
          <th>MAC</th>
          <th>Person</th>
          <th>Aktion</th>
        </tr>
      </thead>
      <tbody id="tbl-body"></tbody>
    </table>
  </div>
  <p id="counter"></p>
</div>

<style>
  .visually-hidden {
    position: absolute; width: 1px; height: 1px;
    padding: 0; margin: -1px; overflow: hidden;
    clip: rect(0,0,0,0); white-space: nowrap; border: 0;
  }
</style>

<script>
  async function loadAll() {
    const errEl = document.getElementById('global-err');
    errEl.hidden = true;
    document.getElementById('loading').hidden = false;
    document.getElementById('table-wrap').hidden = true;

    try {
      const data = await fetch('api/devices').then((r) => r.json());
      if (!data.ok) throw new Error(data.error || 'Unbekannter Fehler');
      renderTable(data.items);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      document.getElementById('loading').hidden = true;
      document.getElementById('table-wrap').hidden = false;
    }
  }

  function renderTable(items) {
    /* … */
  }

  loadAll();
</script>
<!-- #endregion -->
```

---

## 9. Mental Test-Pass vor `build_status: ok`

Bevor das Build als `ok` markiert wird, durchgehen:

- [ ] Alle Farben sind `var(--*)` — kein `#`-Hex außer schwarz/weiß für
      Logos/SVG-Assets.
- [ ] Tabelle (falls vorhanden) ist in `overflow-x:auto`-Wrapper.
- [ ] Inputs/Selects/Textareas haben kein eigenes `max-width` < 100%.
- [ ] Bei 320 px Viewport-Breite: bleibt alles lesbar, kein horizontaler
      Page-Scroll, alle Buttons noch klickbar?
- [ ] Bei 600 px: greift mind. eine `@media (max-width: …)`-Regel falls
      die UI dichte Save-Forms hat?
- [ ] `fetch()`-URLs alle relativ (kein `/`-Prefix)?
- [ ] Backend-Endpoints alle mit `{ ok: true|false, ... }`?
- [ ] Kein `position: fixed`, kein externes `<script src>`, kein
      `@import` für Fonts?

Wenn auch nur ein Punkt offen ist: erst die UI flickschustern, dann
`build_status: ok` setzen.
