'use strict';
/* Loading screen shown while an already-configured omadia install boots. */
const PHASE_PCT = {
  'starting-db': 15,
  'starting-kernel': 35,
  'waiting-kernel': 60,
  'starting-ui': 85,
  ready: 100,
  error: 100,
};

const msgEl = document.getElementById('progressMsg');

if (!window.omadia) {
  // Preload bridge failed — show it instead of a frozen progress bar.
  if (msgEl) msgEl.textContent = 'Internal error: the app bridge did not load (tray → Open Logs).';
} else {
  window.omadia.onBootProgress((p) => {
    const fill = document.getElementById('barFill');
    fill.style.width = (PHASE_PCT[p.phase] ?? 10) + '%';
    if (msgEl) msgEl.textContent = p.message + (p.detail ? ' — ' + p.detail : '');
    if (p.phase === 'error') fill.style.background = 'var(--err)';
  });

  // Live, granular startup log for verbosity.
  if (window.omadia.onBootLog) {
    const logEl = document.getElementById('bootLog');
    window.omadia.onBootLog((line) => {
      if (!logEl) return;
      const row = document.createElement('div');
      const cls = line.level === 'ERROR' ? 'l-err' : line.level === 'WARN' ? 'l-warn' : '';
      if (cls) row.className = cls;
      row.textContent = line.msg;
      logEl.appendChild(row);
      while (logEl.childElementCount > 400) logEl.removeChild(logEl.firstChild);
      logEl.scrollTop = logEl.scrollHeight;
    });
  }
}
