/**
 * Unit tests for the renderer log-file pointer (OM-63).
 *
 * The finding: the wizard/loading error strings sent users to "tray → Open
 * Logs", a menu-bar control that was invisible when its icon was missing — so
 * the only route to the log named a control the user could not see. The fix
 * passes the log path to the page as a `log` query parameter (main.ts
 * `loadRenderer`) and `wizard-i18n.js` surfaces it, which has to keep working
 * even when the preload bridge failed to load — the case IPC cannot cover.
 *
 * Like bootView.test.mts, `wizard-i18n.js` is a classic CSP script that attaches
 * to `window`, so it loads in a `node:vm` context with a stub window/navigator.
 * The point under test is exactly the fallback branch: real path present vs not,
 * in both locales.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.join(here, '..', 'src', 'renderer', 'wizard-i18n.js'),
  'utf8',
);

interface I18nWindow {
  omadiaLogPath(): string;
  omadiaLogHint(wt: (key: string, fallback: string) => string): string;
  wizardT(key: string, fallback: string): string;
}

/** Load wizard-i18n.js under a stub window with the given locale + page search. */
function load(locale: string, search: string): I18nWindow {
  const win = { location: { search } } as unknown as I18nWindow & {
    location: { search: string };
  };
  const context = vm.createContext({
    window: win,
    navigator: { language: locale },
    URLSearchParams,
    Object,
  });
  vm.runInContext(source, context);
  return win;
}

describe('omadiaLogPath', () => {
  it('reads the log path out of the page query string', () => {
    const w = load('en-US', '?log=' + encodeURIComponent('/Users/x/omadia-desktop.log'));
    assert.equal(w.omadiaLogPath(), '/Users/x/omadia-desktop.log');
  });

  it('returns empty string when no log param was passed', () => {
    assert.equal(load('en-US', '').omadiaLogPath(), '');
  });
});

describe('omadiaLogHint', () => {
  it('names the real log file when the path is known (English)', () => {
    const w = load('en-US', '?log=' + encodeURIComponent('/var/log/omadia-desktop.log'));
    const hint = w.omadiaLogHint(w.wizardT);
    assert.match(hint, /Log file:/);
    assert.match(hint, /\/var\/log\/omadia-desktop\.log$/);
    // The whole point of OM-63: no route through the invisible tray when we have the path.
    assert.doesNotMatch(hint, /Open Logs|Logs öffnen/);
  });

  it('names the real log file in German', () => {
    const w = load('de-DE', '?log=' + encodeURIComponent('/var/log/omadia-desktop.log'));
    const hint = w.omadiaLogHint(w.wizardT);
    assert.match(hint, /Protokolldatei:/);
    assert.match(hint, /\/var\/log\/omadia-desktop\.log$/);
  });

  it('falls back to the menu-bar hint only when the path is absent', () => {
    const w = load('en-US', '');
    assert.match(w.omadiaLogHint(w.wizardT), /menu-bar icon/);
  });
});
