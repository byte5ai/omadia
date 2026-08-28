/**
 * Decision logic for the boot/loading screen (OM-59, OM-60).
 *
 * Two field findings meet on this one screen, which every already-configured
 * user sees on EVERY start:
 *
 *  - **OM-59:** it was hardwired English while the app language was German, and
 *    it rendered the supervisor's `message` RAW. The German phase strings had
 *    existed in `wizard-i18n.js` all along (`boot.starting-db` and friends) and
 *    the wizard already used them — so a first-time user got German boot
 *    messages and a daily user got English ones.
 *  - **OM-60:** it appended EVERY log line unfiltered, so users read things like
 *    `[middleware] microsoft365 integration DISABLED (…) — set MICROSOFT_APP_*
 *    in .env`. That the screen shows something at all is an improvement worth
 *    keeping (it is where the evidence for the update-loop finding came from),
 *    so the answer is not silence: it is a plain-language state up front and the
 *    full log one click away.
 *
 * An ERROR line is the exception to "collapsed by default". Hiding the one line
 * that explains a stuck boot behind a disclosure would recreate the original
 * complaint in a new place, so an error reveals the detail view itself.
 *
 * Split out of `loading.js` as pure functions so the ordering and the
 * localization fallbacks are unit-testable without a DOM: the renderer runs
 * under a strict CSP as a classic script, so this attaches to `window` rather
 * than using modules, and the tests load it with `node:vm` and a stub window.
 */
'use strict';

(function (globalScope) {
  /** Progress-bar percentage per supervisor boot phase. */
  var PHASE_PERCENT = {
    'starting-db': 15,
    'starting-kernel': 35,
    'waiting-kernel': 60,
    'starting-ui': 85,
    ready: 100,
    error: 100,
  };

  /** Unknown phases still move the bar off zero rather than looking frozen. */
  var UNKNOWN_PHASE_PERCENT = 10;

  /** Log rows kept in the DOM; older ones are dropped. */
  var MAX_LOG_ROWS = 400;

  function phasePercent(phase) {
    return Object.prototype.hasOwnProperty.call(PHASE_PERCENT, phase)
      ? PHASE_PERCENT[phase]
      : UNKNOWN_PHASE_PERCENT;
  }

  /**
   * The user-facing line for a boot phase.
   *
   * Prefers the shared `boot.<phase>` dictionary entry — the same key the wizard
   * uses — and falls back to the supervisor's English `message` for a phase no
   * dictionary knows. That ordering is the whole fix: the raw English message
   * becomes the LAST resort instead of the only option.
   */
  function phaseMessage(progress, translate) {
    var fallback = (progress && progress.message) || '';
    var phase = progress && progress.phase;
    if (!phase) return fallback;
    var localized = translate('boot.' + phase, fallback);
    var detail = progress.detail ? ' — ' + progress.detail : '';
    return localized + detail;
  }

  /** CSS class for a streamed log line's level. */
  function logLineClass(level) {
    if (level === 'ERROR') return 'l-err';
    if (level === 'WARN') return 'l-warn';
    return '';
  }

  /**
   * Whether a line is important enough to open the collapsed detail view.
   *
   * Errors only. Warnings are routine here — the boot legitimately reports
   * disabled optional integrations as warnings, which is exactly the developer
   * noise OM-60 is about, so promoting them would defeat the change.
   */
  function shouldAutoRevealDetails(level) {
    return level === 'ERROR';
  }

  /**
   * Label for the disclosure control.
   *
   * Counting is deliberate: a bare "Details" gives no hint whether anything
   * happened, and a stuck boot with 200 hidden lines should look different from
   * a clean one with 12.
   */
  function detailSummaryLabel(count, translate) {
    if (count <= 0) return translate('loading.details.empty', 'Startup log');
    var template = translate('loading.details.count', 'Startup log ({count} lines)');
    return template.replace('{count}', String(count));
  }

  globalScope.omadiaBootView = {
    PHASE_PERCENT: PHASE_PERCENT,
    UNKNOWN_PHASE_PERCENT: UNKNOWN_PHASE_PERCENT,
    MAX_LOG_ROWS: MAX_LOG_ROWS,
    phasePercent: phasePercent,
    phaseMessage: phaseMessage,
    logLineClass: logLineClass,
    shouldAutoRevealDetails: shouldAutoRevealDetails,
    detailSummaryLabel: detailSummaryLabel,
  };
})(typeof window !== 'undefined' ? window : globalThis);
