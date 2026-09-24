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

/*
 * The call sites. The helper above can be right and the user still never sees a
 * path: the first draft appended the pointer only to the `res.error || fallback`
 * fallback, and ipc.ts `complete` always answers with the thrown message, so a
 * real first-run failure showed no path at all. These run the actual page
 * scripts against a stub DOM holding just the members they touch.
 */
const LOG = '/Users/x/Library/Logs/omadia/omadia-desktop.log';
const rendererSource = (file: string): string =>
  fs.readFileSync(path.join(here, '..', 'src', 'renderer', file), 'utf8');

interface StubElement {
  textContent: string;
  className: string;
  [member: string]: unknown;
}

function stubElement(): StubElement {
  const classes = new Set<string>();
  return {
    textContent: '',
    className: '',
    value: '',
    checked: false,
    style: {},
    dataset: {},
    childElementCount: 0,
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      toggle: (c: string, on?: boolean) =>
        (on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c),
    },
    addEventListener: () => {},
    appendChild: () => {},
  };
}

/** Run renderer scripts, in page order, under a stub window/document. */
function runPage(scripts: readonly string[], bridge: unknown) {
  const els = new Map<string, StubElement>();
  const el = (id: string): StubElement => {
    if (!els.has(id)) els.set(id, stubElement());
    return els.get(id) as StubElement;
  };
  const context = vm.createContext({
    window: { omadia: bridge, location: { search: '?log=' + encodeURIComponent(LOG), hash: '' } },
    navigator: { language: 'en-US' },
    document: {
      body: el('body'),
      getElementById: el,
      querySelector: (sel: string) => el(sel.replace(/^#/, '')),
      querySelectorAll: () => [],
      createElement: stubElement,
    },
    URLSearchParams,
    setInterval,
    clearInterval,
  });
  for (const file of scripts) vm.runInContext(rendererSource(file), context);
  return { el, provision: context['provision'] as (() => Promise<void>) | undefined };
}

describe('setup failure names the log file (wizard.js provision)', () => {
  async function provisionError(complete: () => Promise<unknown>): Promise<string> {
    const bridge = { complete, onBootProgress: () => () => {}, onBootLog: () => () => {} };
    const page = runPage(['wizard-i18n.js', 'wizard.js'], bridge);
    assert.ok(page.provision, 'wizard.js must declare provision()');
    await page.provision();
    return page.el('provisionError').textContent;
  }

  it('appends the path to the error the main process reported', async () => {
    const text = await provisionError(async () => ({ ok: false, error: 'Port 5432 is in use.' }));
    assert.equal(text, `Port 5432 is in use. Log file: ${LOG}`);
  });

  it('appends the path when the IPC call itself rejected', async () => {
    const text = await provisionError(async () => {
      throw new Error('spawn ENOENT');
    });
    assert.equal(text, `spawn ENOENT Log file: ${LOG}`);
  });

  it('appends the path to the generic message when no error text came back', async () => {
    const text = await provisionError(async () => ({ ok: false, error: '' }));
    assert.equal(text, `Setup failed. Check the logs. Log file: ${LOG}`);
  });
});

describe('bridge-missing messages name the log file', () => {
  it('loading.js shows the path when the preload bridge failed', () => {
    const page = runPage(['wizard-i18n.js', 'loading.js'], undefined);
    assert.equal(
      page.el('progressMsg').textContent,
      `Internal error: the app bridge did not load. Log file: ${LOG}`,
    );
  });

  it('wizard.js shows the path when the preload bridge failed', () => {
    const page = runPage(['wizard-i18n.js', 'wizard.js'], undefined);
    assert.equal(
      page.el('testResult').textContent,
      `Internal error: the app bridge did not load. Please reinstall or report this. Log file: ${LOG}`,
    );
  });

  // Without wizard-i18n.js the hint helper is absent. That may cost the pointer,
  // never the message: an unguarded call throws and leaves a frozen screen.
  it('loading.js still shows the message when wizard-i18n.js did not load', () => {
    const page = runPage(['loading.js'], undefined);
    assert.equal(page.el('progressMsg').textContent, 'Internal error: the app bridge did not load.');
  });

  it('wizard.js still shows the message when wizard-i18n.js did not load', () => {
    const page = runPage(['wizard.js'], undefined);
    assert.equal(
      page.el('testResult').textContent,
      'Internal error: the app bridge did not load. Please reinstall or report this.',
    );
  });
});

describe('main.ts hands the log path to every renderer page', () => {
  const main = fs.readFileSync(path.join(here, '..', 'src', 'main.ts'), 'utf8');

  it('loadRenderer sets the `log` query parameter', () => {
    const fn = /function loadRenderer\([\s\S]*?\n\}\n/.exec(main);
    assert.ok(fn, 'main.ts must define loadRenderer');
    assert.match(fn[0], /\.loadFile\(rendererPath\(page\), \{ query: \{ log: logFile\(\) \}/);
  });

  it('no page is loaded around loadRenderer', () => {
    // A bare `win.loadFile(...)` opens the page without the path, and the
    // renderer quietly falls back to the tray hint OM-63 is about.
    assert.equal(main.match(/\.loadFile\(/g)?.length, 1, 'only loadRenderer may call loadFile');
  });
});
