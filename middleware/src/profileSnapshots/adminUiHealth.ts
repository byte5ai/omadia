/**
 * Server-rendered Admin-UI for the drift / health-score view (OB-65).
 *
 * Surfaced at GET /api/v1/profiles/health/admin-ui — vanilla JS, fetches
 * the Slice-3 JSON routes (`/profiles/health` and `/profiles/:id/health`)
 * via `fetch()`. Brand-aligned: neutral / amber / red on state — no
 * Magenta (reserved for the b5-colon mark, per feedback-ui-spec-stack-binding).
 *
 * The page intentionally mirrors the snapshot admin-ui's structure so the
 * operator's mental model stays consistent across the lifecycle tabs.
 */

export function renderHealthAdminUi(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Drift — Profile Health</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg: #f7f7f8;
    --surface: #ffffff;
    --border: #d8dce0;
    --text: #16181d;
    --muted: #5b6068;
    --accent: #009fe3;
    --warning: #e0a82e;
    --danger: #d9354c;
    --success: #18a058;
    --mono: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace;
    --radius-sm: 8px;
    --radius-md: 14px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 14px/1.5 system-ui, -apple-system, sans-serif;
    color: var(--text);
    background: var(--bg);
    padding: 24px;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h1 small { font-weight: normal; color: var(--muted); font-family: var(--mono); }
  p.lede { color: var(--muted); margin: 0 0 16px; }
  .actions { margin: 16px 0; display: flex; gap: 8px; flex-wrap: wrap; }
  button {
    appearance: none;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    border-radius: var(--radius-sm);
    padding: 6px 12px;
    font: inherit;
    cursor: pointer;
  }
  button:hover { border-color: var(--text); }
  button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  table {
    width: 100%;
    border-collapse: collapse;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  th, td {
    text-align: left;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  th { background: #fafafa; font-weight: 600; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  tr:last-child td { border-bottom: none; }
  td.id { font-family: var(--mono); font-size: 13px; }
  td.computed { color: var(--muted); font-family: var(--mono); font-size: 13px; }
  .pill {
    display: inline-block;
    border-radius: 999px;
    padding: 2px 10px;
    font-size: 12px;
    font-weight: 600;
    background: var(--bg);
    border: 1px solid var(--border);
  }
  .pill.green { background: rgba(24, 160, 88, 0.12); border-color: var(--success); color: var(--success); }
  .pill.amber { background: rgba(224, 168, 46, 0.16); border-color: var(--warning); color: #8a6310; }
  .pill.red { background: rgba(217, 53, 76, 0.12); border-color: var(--danger); color: var(--danger); }
  .empty { color: var(--muted); padding: 24px; text-align: center; }
  .footnote { color: var(--muted); font-size: 12px; margin-top: 16px; }
  .footnote code { background: var(--surface); padding: 1px 4px; border-radius: 4px; border: 1px solid var(--border); }
</style>
</head>
<body>
  <h1>Profile Drift <small>/ health</small></h1>
  <p class="lede">
    Heuristik basierend auf Asset-Gewichten — kein automatischer
    Reject-Trigger. Score 100 = identisch zum letzten deploy-ready Snapshot.
  </p>
  <div class="actions">
    <button id="reload" class="primary">Reload</button>
  </div>
  <div id="content"><p class="empty">Loading…</p></div>
  <p class="footnote">
    Daily sweep: <code>0 3 * * *</code> UTC. Profile ohne deploy-ready
    Snapshot werden nicht überwacht — Operator muss erst eine Baseline
    markieren.
  </p>
<script>
  const content = document.getElementById('content');
  const reload = document.getElementById('reload');

  function pillClass(score) {
    if (score >= 90) return 'green';
    if (score >= 70) return 'amber';
    return 'red';
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toISOString().replace('T', ' ').replace('Z', ' UTC').slice(0, 19) + ' UTC';
    } catch { return iso; }
  }

  function escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    }[c]));
  }

  async function load() {
    reload.disabled = true;
    content.innerHTML = '<p class="empty">Loading…</p>';
    try {
      const res = await fetch('/api/v1/profiles/health', { credentials: 'same-origin' });
      if (res.status === 503) {
        content.innerHTML = '<p class="empty">Drift detection not configured on this instance (snapshot service or DB pool missing).</p>';
        return;
      }
      if (!res.ok) {
        const text = await res.text();
        content.innerHTML = '<p class="empty">Error loading drift list: ' + escape(text.slice(0, 200)) + '</p>';
        return;
      }
      const body = await res.json();
      const profiles = Array.isArray(body.profiles) ? body.profiles : [];
      if (profiles.length === 0) {
        content.innerHTML = '<p class="empty">No drift records yet — Operator hat noch keinen deploy-ready Snapshot oder die erste Sweep ist noch nicht gelaufen.</p>';
        return;
      }
      const rows = profiles.map((p) => {
        const score = Number(p.latest_score) || 0;
        const cls = pillClass(score);
        const profileLink = '/api/v1/profiles/' + encodeURIComponent(p.profile_id) + '/snapshots/admin-ui';
        return '<tr>' +
          '<td class="id"><a href="' + escape(profileLink) + '">' + escape(p.profile_id) + '</a></td>' +
          '<td><span class="pill ' + cls + '">' + score + ' / 100</span></td>' +
          '<td>' + (p.diverged_count || 0) + '</td>' +
          '<td class="computed">' + escape(fmtTime(p.computed_at)) + '</td>' +
        '</tr>';
      }).join('');
      content.innerHTML =
        '<table>' +
          '<thead><tr><th>Profile</th><th>Score</th><th>Diverged Assets</th><th>Computed</th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>';
    } catch (e) {
      content.innerHTML = '<p class="empty">Network error: ' + escape(String(e && e.message || e)) + '</p>';
    } finally {
      reload.disabled = false;
    }
  }

  reload.addEventListener('click', load);
  load();
</script>
</body>
</html>`;
}
