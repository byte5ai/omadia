/**
 * The navigation guards every webContents gets (the Electron-facing half).
 *
 * Driven through a recording stand-in for `webContents`, with the Electron
 * surface injected, so no real `shell` or `BrowserWindow` is touched. What is
 * pinned: a foreign link from the app never replaces the web UI and opens in
 * the system browser instead; a script, data or file target is refused
 * outright; an IdP page reached by a redirect can finish the sign-in in the
 * window; popups are either sandboxed and bridge-less (same app) or handed to
 * the system browser (anything else), and `about:blank` is refused.
 */
import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import type { WindowOpenHandlerResponse } from 'electron';

import {
  installNavigationGuards,
  type GuardableContents,
  type WillNavigateEvent,
} from '../src/navigationGuards.ts';
import type { TrustedTargets } from '../src/navigationPolicy.ts';

const UI = 'http://127.0.0.1:4567';
const KERNEL = 'http://127.0.0.1:8769';
const IDP_PAGE = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=synthetic';

interface Harness {
  /** The document on screen, as `webContents.getURL()` reports it. */
  current: string;
  trusted: TrustedTargets;
  readonly opened: string[];
  readonly logged: string[];
  /** Fire will-navigate; returns whether the navigation was prevented. */
  navigate(url: string): boolean;
  /** Fire the window-open handler. */
  open(url: string): WindowOpenHandlerResponse;
  openExternalFails: boolean;
  /** `getURL()` throws, as it does on a destroyed webContents. */
  getUrlThrows: boolean;
}

function harness(): Harness {
  let willNavigate: ((event: WillNavigateEvent) => void) | null = null;
  let windowOpen: ((details: { readonly url: string }) => WindowOpenHandlerResponse) | null = null;

  const h: Harness = {
    current: `${UI}/chat`,
    trusted: { origins: [KERNEL, UI] },
    opened: [],
    logged: [],
    openExternalFails: false,
    getUrlThrows: false,
    navigate(url) {
      let prevented = false;
      assert.ok(willNavigate, 'will-navigate listener installed');
      willNavigate({ url, preventDefault: () => (prevented = true) });
      return prevented;
    },
    open(url) {
      assert.ok(windowOpen, 'window-open handler installed');
      return windowOpen({ url });
    },
  };

  const contents: GuardableContents = {
    getURL: () => {
      if (h.getUrlThrows) throw new Error('Object has been destroyed');
      return h.current;
    },
    on: (_event, listener) => {
      willNavigate = listener;
    },
    setWindowOpenHandler: (handler) => {
      windowOpen = handler;
    },
  };

  installNavigationGuards(contents, {
    trusted: () => h.trusted,
    openExternal: (url) => {
      h.opened.push(url);
      return h.openExternalFails ? Promise.reject(new Error('no handler')) : Promise.resolve();
    },
    log: {
      info: (message) => h.logged.push(`INFO ${message}`),
      warn: (message) => h.logged.push(`WARN ${message}`),
    },
  });
  return h;
}

/** Popups hand off on the next turn, after the handler has returned. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('will-navigate from the app', () => {
  it('keeps a foreign site out of the window and opens exactly that URL in the system browser', () => {
    assert.equal(h.navigate('https://evil.example/path?q=1'), true);
    assert.deepEqual(h.opened, ['https://evil.example/path?q=1']);
  });

  it('diverts a link in an assistant answer the same way', () => {
    // Markdown links in chat, routine answers, memory and plugin setup guides
    // are plain in-place navigations from the web UI's main frame.
    assert.equal(h.navigate('https://docs.example.com/how-to'), true);
    assert.deepEqual(h.opened, ['https://docs.example.com/how-to']);
  });

  it("lets the app move between its own pages and to the kernel's routes", () => {
    assert.equal(h.navigate(`${UI}/login`), false);
    assert.equal(h.navigate(`${UI}/bot-api/v1/auth/login/entra/start?return=%2Fchat`), false);
    assert.equal(h.navigate(`${KERNEL}/api/v1/diagrams/synthetic.png`), false);
    assert.deepEqual(h.opened, []);
  });

  it('refuses script, data and file targets without handing them to the OS', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'about:blank']) {
      assert.equal(h.navigate(url), true, url);
    }
    assert.deepEqual(h.opened, []);
  });

  it('never writes the full URL to the log, only where it pointed', () => {
    h.navigate('https://login.microsoftonline.com/common/oauth2/v2.0/logout?id_token_hint=synthetic.jwt.value');
    h.navigate('javascript:alert(document.cookie)');
    assert.equal(h.logged.length, 2);
    assert.ok(h.logged.every((line) => !line.includes('synthetic.jwt.value') && !line.includes('cookie')), h.logged.join('\n'));
    assert.match(h.logged[0] ?? '', /https:\/\/login\.microsoftonline\.com/);
  });

  it('survives the system browser refusing the URL', async () => {
    h.openExternalFails = true;
    assert.equal(h.navigate('https://evil.example/'), true);
    await nextTurn();
    assert.ok(h.logged.some((line) => line.startsWith('WARN') && line.includes('https://evil.example')));
  });

  it('applies the same rules to navigations from the bundled wizard page', () => {
    h.current = 'file:///opt/omadia/dist/renderer/wizard.html?log=x';
    assert.equal(h.navigate('https://evil.example/'), true);
    assert.equal(h.navigate('file:///opt/omadia/dist/renderer/loading.html'), true);
    assert.deepEqual(h.opened, ['https://evil.example/']);
  });

  it('treats a window whose URL cannot be read like the app', () => {
    h.getUrlThrows = true;
    assert.equal(h.navigate('https://evil.example/'), true);
    assert.equal(h.navigate('javascript:alert(1)'), true);
    assert.deepEqual(h.opened, ['https://evil.example/']);
  });
});

describe('will-navigate mid sign-in on a foreign page', () => {
  it("lets the IdP's own form posts and hops run in the window", () => {
    h.current = IDP_PAGE;
    assert.equal(h.navigate('https://login.microsoftonline.com/common/login'), false);
    assert.equal(h.navigate(`${KERNEL}/api/v1/auth/login/entra/cb?code=synthetic`), false);
    assert.deepEqual(h.opened, []);
  });

  it('still refuses script, data and file targets there', () => {
    h.current = IDP_PAGE;
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
      assert.equal(h.navigate(url), true, url);
    }
    assert.deepEqual(h.opened, []);
  });

  it('sends the IdP logout from the app to the system browser', () => {
    assert.equal(h.navigate('https://login.microsoftonline.com/common/oauth2/v2.0/logout'), true);
    assert.deepEqual(h.opened, ['https://login.microsoftonline.com/common/oauth2/v2.0/logout']);
  });
});

describe('window.open and target="_blank"', () => {
  it('opens a same-app popup as a sandboxed child window with no preload', () => {
    const response = h.open(`${UI}/bot-api/v1/attachments/synthetic`);
    assert.deepEqual(response, {
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      },
    });
    assert.equal('preload' in (response.overrideBrowserWindowOptions?.webPreferences ?? {}), false);
  });

  it('hands a foreign popup to the system browser after refusing it', async () => {
    assert.deepEqual(h.open('https://github.com/byte5ai/omadia/issues/new?title=x'), { action: 'deny' });
    assert.deepEqual(h.opened, [], 'the hand-off waits until the handler has returned');
    await nextTurn();
    assert.deepEqual(h.opened, ['https://github.com/byte5ai/omadia/issues/new?title=x']);
  });

  it('refuses about:blank and script popups outright', async () => {
    for (const url of ['about:blank', '', 'javascript:alert(1)', 'file:///etc/passwd']) {
      assert.deepEqual(h.open(url), { action: 'deny' }, url);
    }
    await nextTurn();
    assert.deepEqual(h.opened, []);
  });

  it('decides popups by their target, even from a foreign page', async () => {
    h.current = IDP_PAGE;
    assert.deepEqual(h.open('https://login.microsoftonline.com/help'), { action: 'deny' });
    await nextTurn();
    assert.deepEqual(h.opened, ['https://login.microsoftonline.com/help']);
  });
});

describe('the trust set is read per event', () => {
  it('honours a web UI origin learned after the guards were installed', () => {
    // The loading screen is up while the stack boots; the UI origin is unknown.
    h.current = 'file:///opt/omadia/dist/renderer/loading.html?log=x';
    h.trusted = { origins: [KERNEL] };
    assert.equal(h.navigate(`${UI}/chat`), true, 'no web UI is serving yet');
    h.trusted = { origins: [KERNEL, UI] };
    assert.equal(h.navigate(`${UI}/chat`), false);
    assert.equal(h.open(`${UI}/chat`).action, 'allow');
  });
});
