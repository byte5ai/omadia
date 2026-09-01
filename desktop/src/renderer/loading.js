'use strict';
/*
 * Loading screen shown while an already-configured omadia install boots.
 *
 * Presentation only — every decision (phase percentage, which dictionary key to
 * try, when an error must open the detail view) lives in `bootView.js` so it can
 * be tested without a DOM. See that file for why OM-59 and OM-60 both land here.
 */

var view = window.omadiaBootView;
var wt = window.wizardT || function (_key, fallback) { return fallback; };
if (window.applyWizardLocale) window.applyWizardLocale();

var msgEl = document.getElementById('progressMsg');
var detailsEl = document.getElementById('bootDetails');
var summaryEl = document.getElementById('bootDetailsSummary');
var logEl = document.getElementById('bootLog');
var logRowCount = 0;

function refreshSummary() {
  if (summaryEl && view) summaryEl.textContent = view.detailSummaryLabel(logRowCount, wt);
}

if (!window.omadia) {
  // Preload bridge failed — say so instead of showing a frozen progress bar.
  if (msgEl) {
    msgEl.textContent =
      wt('loading.bridgeMissing', 'Internal error: the app bridge did not load.') +
      ' ' +
      window.omadiaLogHint(wt);
  }
} else {
  refreshSummary();

  window.omadia.onBootProgress(function (p) {
    var fill = document.getElementById('barFill');
    if (fill) {
      fill.style.width = view.phasePercent(p.phase) + '%';
      if (p.phase === 'error') fill.style.background = 'var(--err)';
    }
    if (msgEl) msgEl.textContent = view.phaseMessage(p, wt);
  });

  if (window.omadia.onBootLog) {
    window.omadia.onBootLog(function (line) {
      if (!logEl) return;
      var row = document.createElement('div');
      var cls = view.logLineClass(line.level);
      if (cls) row.className = cls;
      row.textContent = line.msg;
      logEl.appendChild(row);
      logRowCount += 1;
      while (logEl.childElementCount > view.MAX_LOG_ROWS) {
        logEl.removeChild(logEl.firstChild);
      }
      logEl.scrollTop = logEl.scrollHeight;
      refreshSummary();
      if (detailsEl && view.shouldAutoRevealDetails(line.level)) detailsEl.open = true;
    });
  }
}
