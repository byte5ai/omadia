/**
 * Server-rendered Admin-UI for the profile-snapshot tab (OB-64 Slice E).
 *
 * Returns a self-contained HTML page that an operator can open at
 *   GET /api/v1/profiles/:id/snapshots/admin-ui
 *
 * The page consumes the JSON routes from Slice D via `fetch()`. It's
 * intentionally framework-free — vanilla JS keeps the dependency surface
 * small and makes this snippet portable into the plugin admin-UI iframe
 * pattern documented in `docs/harness-platform/PLAN-admin-ui-theming.md`.
 *
 * The CSS is co-located inline because this view is rendered standalone
 * (not embedded in the web-ui shell). When the upcoming Persona-Pillar
 * lands in `web-ui`, that React surface can call the same JSON routes
 * and replace this view; until then this is the operator surface for
 * the snapshot lifecycle.
 *
 * Brand-rules: no Magenta on state (reserved for the b5-colon mark);
 * states use neutral / amber / red. Pill-radius full only on small
 * status pills; cards are sm-radius.
 */

import { escapeHtml } from './escapeHtml.js';

export function renderSnapshotsAdminUi(profileId: string): string {
  const safeProfileId = escapeHtml(profileId);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Snapshots — ${safeProfileId}</title>
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
  button.danger { background: var(--danger); color: #fff; border-color: var(--danger); }
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
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    text-align: left;
    vertical-align: top;
  }
  th { background: #f0f1f3; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  tr:last-child td { border-bottom: none; }
  td.mono { font-family: var(--mono); font-size: 12px; }
  td.actions-col button { padding: 4px 8px; font-size: 12px; margin-right: 4px; margin-bottom: 4px; }
  .pill {
    display: inline-block;
    border-radius: 999px;
    padding: 2px 10px;
    font-size: 11px;
    font-weight: 600;
    line-height: 1.6;
  }
  .pill.deploy-ready { background: #def5e8; color: var(--success); border: 1px solid var(--success); }
  .pill.drift-low { background: #fff3d4; color: var(--warning); border: 1px solid var(--warning); }
  .pill.drift-zero { background: #eef0f2; color: var(--muted); border: 1px solid var(--border); }
  .empty { padding: 24px; text-align: center; color: var(--muted); }
  .modal-bg {
    position: fixed; inset: 0; background: rgba(15, 18, 24, 0.55);
    display: none; align-items: center; justify-content: center; padding: 24px;
    z-index: 1000;
  }
  .modal-bg.open { display: flex; }
  .modal {
    background: var(--surface); border-radius: var(--radius-md);
    padding: 20px; max-width: 720px; width: 100%; max-height: 80vh;
    overflow: auto; border: 1px solid var(--border);
  }
  .modal h2 { font-size: 16px; margin: 0 0 12px; }
  .modal .close { float: right; background: transparent; border: none; cursor: pointer; font-size: 20px; }
  .diff-table { font-size: 13px; }
  .diff-status { font-weight: 600; }
  .diff-status.added { color: var(--success); }
  .diff-status.removed { color: var(--danger); }
  .diff-status.modified { color: var(--warning); }
  .diff-status.identical { color: var(--muted); }
  .confirm-input {
    width: 100%; padding: 8px 10px;
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    font-family: var(--mono); font-size: 13px; margin: 8px 0;
  }
  .confirm-input.match { border-color: var(--success); }
  .toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: var(--text); color: #fff; padding: 8px 16px;
    border-radius: var(--radius-sm); font-size: 13px;
    opacity: 0; transition: opacity 0.2s; z-index: 2000;
  }
  .toast.show { opacity: 1; }
  .toast.error { background: var(--danger); }
  .form-row { margin: 12px 0; }
  .form-row label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  textarea { width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); font: inherit; min-height: 60px; }
</style>
</head>
<body>
<h1>Snapshots <small>profile: ${safeProfileId}</small></h1>
<div class="actions">
  <button id="btn-create" class="primary">Capture snapshot</button>
  <button id="btn-refresh">Refresh</button>
</div>
<div id="snapshot-list"></div>

<div class="modal-bg" id="diff-modal">
  <div class="modal" role="dialog" aria-labelledby="diff-title">
    <button class="close" data-close-modal="diff-modal" aria-label="Close">×</button>
    <h2 id="diff-title">Diff</h2>
    <div id="diff-body">Loading…</div>
  </div>
</div>

<div class="modal-bg" id="rollback-modal">
  <div class="modal" role="dialog" aria-labelledby="rb-title">
    <button class="close" data-close-modal="rollback-modal" aria-label="Close">×</button>
    <h2 id="rb-title">Confirm rollback</h2>
    <p>Type the first 12 characters of the snapshot's bundle hash to confirm.
       Live <code>agent.md</code> and <code>knowledge/</code> files will be replaced
       with the snapshot contents. Plugin pins are NOT changed.</p>
    <div class="form-row">
      <label>Bundle hash prefix (12 chars)</label>
      <input type="text" id="rb-hash" class="confirm-input" autocomplete="off" maxlength="12">
    </div>
    <div class="actions">
      <button class="danger" id="rb-confirm" disabled>Roll back</button>
      <button data-close-modal="rollback-modal">Cancel</button>
    </div>
  </div>
</div>

<div class="modal-bg" id="create-modal">
  <div class="modal" role="dialog">
    <button class="close" data-close-modal="create-modal" aria-label="Close">×</button>
    <h2>Capture snapshot</h2>
    <div class="form-row">
      <label>Notes (optional)</label>
      <textarea id="create-notes" placeholder="Why are you snapshotting this state?"></textarea>
    </div>
    <div class="form-row">
      <label><input type="checkbox" id="create-vendor"> Vendor plugin ZIPs into the bundle (air-gap exports)</label>
    </div>
    <div class="actions">
      <button class="primary" id="create-confirm">Capture</button>
      <button data-close-modal="create-modal">Cancel</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
(() => {
  const PROFILE_ID = ${JSON.stringify(profileId)};
  const BASE = '../../../profiles/' + encodeURIComponent(PROFILE_ID);
  const $ = (id) => document.getElementById(id);
  const toast = (msg, error = false) => {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (error ? ' error' : '');
    setTimeout(() => { t.className = 'toast'; }, 2400);
  };
  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString();
  };
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  function openModal(id) { $(id).classList.add('open'); }
  function closeModal(id) { $(id).classList.remove('open'); }
  document.querySelectorAll('[data-close-modal]').forEach((el) => {
    el.addEventListener('click', () => closeModal(el.getAttribute('data-close-modal')));
  });

  async function api(path, opts = {}) {
    const res = await fetch(BASE + path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(body.message || res.statusText);
    }
    return res.json();
  }

  async function loadList() {
    const list = $('snapshot-list');
    list.innerHTML = '<p class="empty">Loading…</p>';
    try {
      const { snapshots } = await api('/snapshots');
      if (!snapshots || snapshots.length === 0) {
        list.innerHTML = '<p class="empty">No snapshots yet. Capture one to mark a known-good state.</p>';
        return;
      }
      const rows = snapshots.map((s) => {
        const hashShort = String(s.bundle_hash || '').slice(0, 12);
        const pills = [];
        if (s.is_deploy_ready) pills.push('<span class="pill deploy-ready">deploy-ready</span>');
        const driftPill = (typeof s.drift_score === 'number' && s.drift_score > 0)
          ? '<span class="pill drift-low">drift ' + s.drift_score.toFixed(2) + '</span>'
          : '<span class="pill drift-zero">no drift</span>';
        pills.push(driftPill);
        return '<tr>' +
          '<td>' + escapeHtml(fmtDate(s.created_at)) + '</td>' +
          '<td class="mono">' + escapeHtml(hashShort) + '</td>' +
          '<td>' + escapeHtml(s.created_by || '') + '</td>' +
          '<td>' + escapeHtml(s.notes || '') + '</td>' +
          '<td>' + pills.join(' ') + '</td>' +
          '<td class="actions-col">' +
            '<button data-action="diff-live" data-id="' + escapeHtml(s.snapshot_id) + '">Diff vs live</button>' +
            '<button data-action="mark" data-id="' + escapeHtml(s.snapshot_id) + '"' + (s.is_deploy_ready ? ' disabled' : '') + '>Mark deploy-ready</button>' +
            '<button data-action="rollback" data-id="' + escapeHtml(s.snapshot_id) + '" data-hash="' + escapeHtml(hashShort) + '" class="danger">Roll back</button>' +
            '<button data-action="download" data-id="' + escapeHtml(s.snapshot_id) + '">Download</button>' +
          '</td>' +
        '</tr>';
      }).join('');
      list.innerHTML =
        '<table><thead><tr>' +
        '<th>Created</th><th>Hash</th><th>By</th><th>Notes</th><th>Status</th><th>Actions</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>';
    } catch (err) {
      list.innerHTML = '<p class="empty">Failed to load: ' + escapeHtml(err.message) + '</p>';
    }
  }

  async function showDiff(snapshotId) {
    openModal('diff-modal');
    $('diff-body').textContent = 'Loading…';
    try {
      const { diffs } = await api('/diff?base=' + snapshotId + '&target=live');
      if (!diffs || diffs.length === 0) {
        $('diff-body').innerHTML = '<p class="empty">No differences.</p>';
        return;
      }
      const rows = diffs.map((d) =>
        '<tr>' +
          '<td>' + escapeHtml(d.path) + '</td>' +
          '<td class="diff-status ' + escapeHtml(d.status) + '">' + escapeHtml(d.status) + '</td>' +
          '<td class="mono">' + escapeHtml((d.base_sha256 || '').slice(0, 12)) + '</td>' +
          '<td class="mono">' + escapeHtml((d.target_sha256 || '').slice(0, 12)) + '</td>' +
        '</tr>'
      ).join('');
      $('diff-body').innerHTML =
        '<table class="diff-table"><thead><tr>' +
        '<th>Path</th><th>Status</th><th>Snapshot hash</th><th>Live hash</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>';
    } catch (err) {
      $('diff-body').innerHTML = '<p class="empty">Failed: ' + escapeHtml(err.message) + '</p>';
    }
  }

  function showRollbackConfirm(snapshotId, hashPrefix) {
    openModal('rollback-modal');
    const input = $('rb-hash');
    const btn = $('rb-confirm');
    input.value = '';
    btn.disabled = true;
    input.classList.remove('match');
    input.oninput = () => {
      const ok = input.value === hashPrefix;
      btn.disabled = !ok;
      input.classList.toggle('match', ok);
    };
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const result = await api('/rollback/' + snapshotId, { method: 'POST', body: '{}' });
        toast('Rolled back · ' + (result.diverged_assets?.length || 0) + ' asset(s) restored');
        closeModal('rollback-modal');
        await loadList();
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
      }
    };
  }

  async function markDeployReady(snapshotId) {
    try {
      await api('/snapshots/' + snapshotId + '/mark-deploy-ready', { method: 'POST', body: '{}' });
      toast('Marked deploy-ready');
      await loadList();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function downloadSnapshot(snapshotId) {
    window.location.href = BASE + '/snapshots/' + snapshotId + '/download';
  }

  async function captureSnapshot() {
    const btn = $('create-confirm');
    btn.disabled = true;
    try {
      const notes = $('create-notes').value.trim() || undefined;
      const vendor = $('create-vendor').checked;
      const body = JSON.stringify({ ...(notes ? { notes } : {}), vendor });
      const result = await api('/snapshot', { method: 'POST', body });
      toast(result.was_existing ? 'No change since last snapshot' : 'Snapshot captured');
      closeModal('create-modal');
      await loadList();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  document.addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.getAttribute('data-action');
    const id = target.getAttribute('data-id');
    if (!action || !id) return;
    if (action === 'diff-live') showDiff(id);
    else if (action === 'mark') markDeployReady(id);
    else if (action === 'rollback') {
      const hash = target.getAttribute('data-hash') || '';
      showRollbackConfirm(id, hash);
    }
    else if (action === 'download') downloadSnapshot(id);
  });

  $('btn-create').addEventListener('click', () => {
    $('create-notes').value = '';
    $('create-vendor').checked = false;
    openModal('create-modal');
  });
  $('btn-refresh').addEventListener('click', loadList);
  $('create-confirm').addEventListener('click', captureSnapshot);

  loadList();
})();
</script>
</body>
</html>`;
}
