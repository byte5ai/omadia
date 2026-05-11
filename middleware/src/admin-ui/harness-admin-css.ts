/**
 * Harness Platform — Admin-UI baseline stylesheet.
 *
 * Embedded as a TS string so the build pipeline (`tsc --outDir dist`) ships
 * it cleanly without an asset-copy step. Tokens mirror
 * `web-dev/app/_lib/theme.css`; keep the two roughly in sync when the
 * design system changes.
 *
 * Served by `routes/harnessAdminUi.ts` at GET /api/_harness/admin-ui.css.
 * Plugin admin-UIs link it via:
 *   <link rel="stylesheet" href="/bot-api/_harness/admin-ui.css" />
 *
 * Decisions captured in docs/harness-platform/PLAN-admin-ui-theming.md:
 *   - Global body styling (no scope class) — all plugins follow our UI.
 *   - Light + dark mode via `@media (prefers-color-scheme: dark)`.
 *   - `.harness-*` prefix on helper classes to avoid plugin-side collisions.
 *   - Layout-constraint custom-properties so plugin CSS can opt-in.
 */
export const HARNESS_ADMIN_CSS = String.raw`/* Harness Platform — Admin-UI baseline. Source of truth:
   middleware/src/admin-ui/harness-admin-css.ts. */

:root {
  color-scheme: light dark;

  /* === byte5 brand tokens (mirrors web-dev/app/_lib/theme.css) === */
  --b5-blau:        #009FE3;
  --b5-blau-dunkel: #004B73;
  --b5-weiss:       #FFFFFF;
  --b5-magenta:     #EA5172;

  --gray-50:  #F4F7FA;
  --gray-100: #E8EEF3;
  --gray-200: #D3DDE5;
  --gray-300: #B4C2CD;
  --gray-400: #8A99A6;
  --gray-500: #5F6E7B;
  --gray-600: #3F4D59;
  --gray-700: #283540;
  --gray-800: #15212B;
  --gray-900: #0A1420;

  --bg:            var(--b5-weiss);
  --bg-soft:       var(--gray-50);
  --bg-elevated:   var(--b5-weiss);

  --fg:            var(--b5-blau-dunkel);
  --fg-strong:     var(--b5-blau-dunkel);
  --fg-muted:      var(--gray-500);
  --fg-subtle:     var(--gray-400);

  --accent:        var(--b5-blau);
  --accent-fg:     var(--b5-weiss);
  --accent-hover:  #0086C0;
  --accent-press:  #006C9C;

  --highlight:     var(--b5-magenta);

  --border:        var(--gray-200);
  --border-strong: var(--gray-300);
  --divider:       rgba(0, 75, 115, 0.12);

  --success:       #15A06B;
  --warning:       #E0A82E;
  --danger:        #D9354C;
  --info:          var(--b5-blau);

  /* COMPAT aliases — same names the web-dev components use, so plugin
     authors copying web-dev classnames find what they expect. */
  --paper:       var(--bg);
  --ink:         var(--fg);
  --muted-ink:   var(--fg-muted);
  --faint-ink:   var(--fg-subtle);
  --rule:        var(--border);
  --rule-strong: var(--border-strong);

  --font-text:    'Nunito Sans', ui-sans-serif, system-ui, -apple-system,
                  'Segoe UI', sans-serif;
  --font-display: 'Days One', 'Nunito Sans', system-ui, sans-serif;
  --font-mono:    'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;

  --radius-xs:   4px;
  --radius-sm:   8px;
  --radius-md:   14px;
  --radius-pill: 9999px;

  --shadow-xs: 0 1px 2px  rgba(0, 75, 115, 0.06);
  --shadow-sm: 0 2px 6px  rgba(0, 75, 115, 0.08);
  --shadow-md: 0 8px 24px rgba(0, 75, 115, 0.10);

  --dur-fast: 140ms;

  /* === Layout constraints — admin-UI iframe sizing in web-dev hostframe.
     Source: web-dev/app/store/[id]/page.tsx grid lg:grid-cols-[1fr_340px]
     within max-w-[1280px] minus padding. Plugin CSS may reference these
     to size tables / cards responsively. === */
  --harness-iframe-max:    812px;
  --harness-iframe-min:    320px;
  --harness-iframe-height: 1000px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg:            #0B1A24;
    --bg-soft:       #102533;
    --bg-elevated:   #15303F;

    --fg:            #E8F2F8;
    --fg-strong:     #FFFFFF;
    --fg-muted:      #A4B4C2;
    --fg-subtle:     #768796;

    --border:        rgba(255, 255, 255, 0.10);
    --border-strong: rgba(255, 255, 255, 0.18);
    --divider:       rgba(255, 255, 255, 0.10);

    --accent-hover:  #33B0E8;
    --accent-press:  #66C1ED;
  }
}

/* === Element baseline =================================================== */

*, *::before, *::after { box-sizing: border-box; }

html, body { height: 100%; }

body {
  margin: 0;
  padding: 1.25rem;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-text);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

h1, h2, h3, h4, h5, h6 {
  font-family: var(--font-display);
  color: var(--fg-strong);
  margin: 0 0 0.5rem;
  line-height: 1.2;
}

h1 { font-size: 1.5rem; }
h2 { font-size: 1.25rem; }
h3 { font-size: 1.05rem; }
h4, h5, h6 { font-size: 1rem; }

p {
  margin: 0 0 0.75rem;
  color: var(--fg);
}

a {
  color: var(--accent);
  text-decoration: underline;
  text-decoration-color: var(--border-strong);
  text-underline-offset: 2px;
}
a:hover { color: var(--accent-hover); }

code, pre, kbd, samp {
  font-family: var(--font-mono);
  font-size: 0.92em;
}

code {
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  padding: 0.05em 0.35em;
}

pre {
  padding: 0.75rem;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow-x: auto;
}

hr {
  border: 0;
  height: 1px;
  background: var(--divider);
  margin: 1rem 0;
}

/* === Tables ============================================================= */

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.92rem;
}

th, td {
  padding: 0.55rem 0.7rem;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--divider);
}

th {
  font-weight: 600;
  font-size: 0.78rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--fg-muted);
  background: var(--bg-soft);
  border-bottom: 1px solid var(--border);
}

tbody tr:hover { background: var(--bg-soft); }

/* === Form controls ====================================================== */

input, select, textarea, button {
  font: inherit;
  color: var(--fg);
}

input, select, textarea {
  width: 100%;
  max-width: 100%;
  padding: 0.45rem 0.65rem;
  background: var(--bg-elevated);
  color: var(--fg);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
}

input[type='checkbox'], input[type='radio'] {
  width: auto;
  accent-color: var(--accent);
}

input:focus, select:focus, textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(0, 159, 227, 0.18);
}

button {
  cursor: pointer;
  padding: 0.5rem 1rem;
  background: var(--bg-soft);
  border: 1px solid var(--border-strong);
  color: var(--fg);
  border-radius: var(--radius-pill);
  font-weight: 600;
  letter-spacing: 0.02em;
  transition: background-color var(--dur-fast), border-color var(--dur-fast),
              color var(--dur-fast);
}

button:hover {
  background: var(--bg-elevated);
  border-color: var(--accent);
  color: var(--accent);
}

button:disabled { opacity: 0.55; cursor: not-allowed; }

/* === Helper classes (.harness-*) ======================================== */

.harness-subtitle {
  color: var(--fg-muted);
  font-size: 0.92rem;
  margin: 0.25rem 0 1.25rem;
}

.harness-empty {
  font-style: italic;
  color: var(--fg-subtle);
}

.harness-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0.5rem 1rem;
  background: var(--bg-soft);
  color: var(--fg);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
  font-weight: 600;
  cursor: pointer;
  transition: background-color var(--dur-fast), border-color var(--dur-fast),
              color var(--dur-fast);
}

.harness-btn:hover {
  background: var(--bg-elevated);
  border-color: var(--accent);
  color: var(--accent);
}

.harness-btn--primary {
  background: var(--accent);
  color: var(--accent-fg);
  border-color: var(--accent);
}

.harness-btn--primary:hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
  color: var(--accent-fg);
}

.harness-input {
  width: 100%;
  max-width: 100%;
}

.harness-table {
  width: 100%;
  border-collapse: collapse;
}

.harness-banner-error,
.harness-banner-info {
  padding: 0.65rem 0.85rem;
  border-radius: var(--radius-sm);
  margin-bottom: 0.85rem;
  font-size: 0.92rem;
  border: 1px solid transparent;
}

.harness-banner-error {
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 30%, transparent);
}

.harness-banner-info {
  background: color-mix(in srgb, var(--info) 10%, transparent);
  color: var(--info);
  border-color: color-mix(in srgb, var(--info) 30%, transparent);
}
`;
