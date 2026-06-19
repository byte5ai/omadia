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

window.omadia.onBootProgress((p) => {
  const fill = document.getElementById('barFill');
  const msg = document.getElementById('progressMsg');
  fill.style.width = (PHASE_PCT[p.phase] ?? 10) + '%';
  msg.textContent = p.message + (p.detail ? ' — ' + p.detail : '');
  if (p.phase === 'error') fill.style.background = 'var(--err)';
});
