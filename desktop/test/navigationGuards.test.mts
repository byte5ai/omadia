/**
 * The navigation guards every webContents gets (the Electron-facing half).
 *
 * Driven through a recording stand-in for `webContents` and its session, with
 * the Electron surface injected, so no real `shell` or `BrowserWindow` is
 * touched. What is pinned: a foreign link from the app never replaces the web
 * UI and opens in the system browser instead; a script, data or file target is
 * refused outright; an IdP page reached by a redirect can finish the sign-in in
 * the window; popups are either sandboxed and bridge-less (same app) or handed
 * to the system browser (anything else), and `about:blank` is refused. No
 * frame and no redirect can hand a URL to the OS protocol handler: subframe
 * navigations and redirects to such schemes are cancelled, and the session
 * never grants Electron's `openExternal` permission. Every other permission is
 * deny by default too: the session's request and check handlers grant only an
 * allowlisted one to a main frame showing the app's own document.
 */
import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WindowOpenHandlerResponse } from 'electron';

import {
  installNavigationGuards,
  type FrameNavigationEvent,
  type GuardableContents,
  type GuardableSession,
  type PermissionCheckDetails,
  type PermissionContents,
  type PermissionRequestDetails,
} from '../src/navigationGuards.ts';
import type { TrustedTargets } from '../src/navigationPolicy.ts';

const UI = 'http://127.0.0.1:4567';
const KERNEL = 'http://127.0.0.1:8769';
const IDP_PAGE = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=synthetic';
const RENDERER = path.resolve('/opt/omadia/resources/app.asar/dist/renderer');
/** The bundled wizard as Electron reports it: `loadFile` adds the log path, a recovery the hash. */
const WIZARD = `${pathToFileURL(path.join(RENDERER, 'wizard.html')).href}?log=%2Ftmp%2Fx.log#recovered`;
const LOADING = `${pathToFileURL(path.join(RENDERER, 'loading.html')).href}?log=%2Ftmp%2Fx.log`;
/** Schemes the OS would hand to an installed program. */
const OS_HANDLED = ['ms-settings:privacy', 'search-ms:query=synthetic', 'facetime:+15550100', 'omadia-custom://open'];

type NavigationListener = (event: FrameNavigationEvent) => void;
type PermissionRequestHandler = Parameters<GuardableSession['setPermissionRequestHandler']>[0];
type PermissionCheckHandler = Parameters<GuardableSession['setPermissionCheckHandler']>[0];

interface Harness {
  /** The document on screen, as `webContents.getURL()` reports it. */
  current: string;
  trusted: TrustedTargets;
  readonly opened: string[];
  readonly logged: string[];
  /** Fire will-navigate; returns whether the navigation was prevented. */
  navigate(url: string): boolean;
  /** Fire will-frame-navigate; returns whether the navigation was prevented. */
  navigateFrame(url: string, isMainFrame: boolean): boolean;
  /** Fire will-redirect; returns whether the navigation was prevented. */
  redirect(url: string, isMainFrame: boolean): boolean;
  /** Fire the window-open handler. */
  open(url: string): WindowOpenHandlerResponse;
  /** Ask the session's permission request handler, for `handlerContents`; returns its answer. */
  requestPermission(permission: string, details: PermissionRequestDetails): boolean | undefined;
  /** Ask the session's permission check handler, for `handlerContents`. */
  checkPermission(permission: string, details: PermissionCheckDetails): boolean;
  /**
   * The webContents Electron hands the permission handlers: this window, or
   * null as for a check made without one.
   */
  handlerContents: PermissionContents | null;
  openExternalFails: boolean;
  /** `getURL()` throws, as it does on a destroyed webContents. */
  getUrlThrows: boolean;
}

function harness(): Harness {
  const listeners = new Map<string, NavigationListener>();
  let windowOpen: ((details: { readonly url: string }) => WindowOpenHandlerResponse) | null = null;
  let permissionRequest: PermissionRequestHandler | null = null;
  let permissionCheck: PermissionCheckHandler | null = null;

  /** Fire a navigation event; returns whether a listener prevented it. */
  const fire = (name: string, url: string, isMainFrame: boolean): boolean => {
    const listener = listeners.get(name);
    assert.ok(listener, `${name} listener installed`);
    let prevented = false;
    listener({ url, isMainFrame, preventDefault: () => (prevented = true) });
    return prevented;
  };

  const h: Harness = {
    current: `${UI}/chat`,
    trusted: { origins: [KERNEL, UI] },
    opened: [],
    logged: [],
    handlerContents: null,
    openExternalFails: false,
    getUrlThrows: false,
    navigate: (url) => fire('will-navigate', url, true),
    navigateFrame: (url, isMainFrame) => fire('will-frame-navigate', url, isMainFrame),
    redirect: (url, isMainFrame) => fire('will-redirect', url, isMainFrame),
    open(url) {
      assert.ok(windowOpen, 'window-open handler installed');
      return windowOpen({ url });
    },
    requestPermission(permission, details) {
      assert.ok(permissionRequest, 'permission request handler installed on the session');
      let answer: boolean | undefined;
      permissionRequest(h.handlerContents, permission, (granted) => (answer = granted), details);
      return answer;
    },
    checkPermission(permission, details) {
      assert.ok(permissionCheck, 'permission check handler installed on the session');
      return permissionCheck(h.handlerContents, permission, requestingOriginOf(details.requestingUrl), details);
    },
  };

  const contents: GuardableContents = {
    session: {
      setPermissionRequestHandler: (handler) => {
        permissionRequest = handler;
      },
      setPermissionCheckHandler: (handler) => {
        permissionCheck = handler;
      },
    },
    getURL: () => {
      if (h.getUrlThrows) throw new Error('Object has been destroyed');
      return h.current;
    },
    on: (event: string, listener: NavigationListener) => {
      listeners.set(event, listener);
    },
    setWindowOpenHandler: (handler) => {
      windowOpen = handler;
    },
  };
  h.handlerContents = contents;

  installNavigationGuards(contents, {
    trusted: () => h.trusted,
    rendererDir: RENDERER,
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

/** What Electron passes a check handler as `requestingOrigin`: the frame's origin, slash-terminated. */
function requestingOriginOf(url: string | undefined): string {
  try {
    const origin = new URL(url ?? '').origin;
    return origin === 'null' ? '' : `${origin}/`;
  } catch {
    return '';
  }
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

describe('subframes: plugin UIs, the builder preview, anything a page embeds', () => {
  it('cancels a subframe navigation that would reach the OS protocol handler', () => {
    for (const url of [...OS_HANDLED, 'file:///etc/passwd']) {
      assert.equal(h.navigateFrame(url, false), true, url);
    }
    assert.deepEqual(h.opened, [], 'nothing is handed to the system browser either');
    assert.equal(h.logged.filter((line) => line.startsWith('WARN')).length, OS_HANDLED.length + 1);
  });

  it('lets a subframe load web pages and what the browser renders in the page', () => {
    for (const url of [
      `${UI}/p/synthetic-plugin/ui/index.html?theme=dark`,
      'https://maps.example/embed?q=synthetic',
      'data:text/html,<p>synthetic</p>',
      `blob:${UI}/5d9c7c2e-0000-4000-8000-000000000000`,
    ]) {
      assert.equal(h.navigateFrame(url, false), false, url);
    }
    assert.deepEqual(h.logged, []);
  });

  it('applies the same rule to the subframes of a foreign page', () => {
    h.current = IDP_PAGE;
    assert.equal(h.navigateFrame('ms-settings:privacy', false), true);
    assert.equal(h.navigateFrame('https://login.microsoftonline.com/common/reprocess', false), false);
  });

  it('leaves the main frame to will-navigate', () => {
    // Electron fires will-frame-navigate for the main frame as well.
    assert.equal(h.navigateFrame('https://evil.example/', true), false);
    assert.deepEqual(h.opened, [], 'will-navigate alone hands foreign links to the system browser');
  });

  it('never writes the full URL to the log', () => {
    h.navigateFrame('search-ms:query=synthetic-secret&crumb=location:C%3A%5C', false);
    assert.equal(h.logged.length, 1);
    assert.match(h.logged[0] ?? '', /search-ms:/);
    assert.equal(h.logged[0]?.includes('synthetic-secret'), false);
  });
});

describe('server redirects', () => {
  it('cancels a redirect to a non-web scheme, in the main frame and in subframes', () => {
    for (const isMainFrame of [true, false]) {
      for (const url of [...OS_HANDLED, 'file:///etc/passwd']) {
        assert.equal(h.redirect(url, isMainFrame), true, `${url} main=${isMainFrame}`);
      }
    }
    assert.deepEqual(h.opened, []);
  });

  it('lets web redirects through, so the in-window sign-in keeps working', () => {
    // Kernel 302 to the IdP, the IdP's own hops, the callback on the kernel.
    assert.equal(h.redirect(IDP_PAGE, true), false);
    assert.equal(h.redirect('https://login.live.com/ppsecure/post.srf', true), false);
    assert.equal(h.redirect(`${KERNEL}/api/v1/auth/login/entra/cb?code=synthetic`, true), false);
    assert.equal(h.redirect('https://cdn.example/asset.js', false), false);
    assert.deepEqual(h.logged, []);
  });
});

describe('the OS protocol handler', () => {
  it("refuses Electron's openExternal permission, whatever it would open and whoever asks", () => {
    // Electron asks for it before it hands a non-web URL from any frame, or
    // from a redirect, to the OS, and grants every request when no handler
    // is set. Not even the app's own main frame gets it.
    for (const isMainFrame of [true, false]) {
      for (const requestingUrl of [`${UI}/chat`, WIZARD, IDP_PAGE]) {
        for (const externalURL of [...OS_HANDLED, 'https://example.com/']) {
          assert.equal(
            h.requestPermission('openExternal', { isMainFrame, requestingUrl, externalURL }),
            false,
            `${externalURL} from ${requestingUrl} main=${isMainFrame}`,
          );
        }
      }
    }
    assert.equal(h.requestPermission('openExternal', { isMainFrame: true }), false, 'also without a URL');
    assert.equal(h.checkPermission('openExternal', { isMainFrame: true, requestingUrl: `${UI}/chat` }), false);
    assert.deepEqual(h.opened, []);
  });

  it("logs the refused scheme and the frame kind, never the URL's content", () => {
    h.requestPermission('openExternal', {
      isMainFrame: false,
      requestingUrl: `${UI}/p/synthetic-plugin/ui/index.html`,
      externalURL: 'search-ms:query=synthetic-secret',
    });
    assert.equal(h.logged.length, 1);
    assert.match(h.logged[0] ?? '', /^WARN .*search-ms:.*subframe/);
    assert.equal(h.logged[0]?.includes('synthetic-secret'), false);
  });
});

describe("session permissions: deny by default, an allowlist for the app's own main frames", () => {
  const CLIPBOARD_WRITE = 'clipboard-sanitized-write';

  /**
   * Put one question to both handlers and require the same answer. Electron
   * runs most permission checks before a request and asks only when the
   * check fails, so a check that passed where a request is refused would skip
   * the gate.
   */
  function decide(permission: string, requestingUrl: string | undefined, isMainFrame: boolean): boolean {
    const details = requestingUrl === undefined ? { isMainFrame } : { isMainFrame, requestingUrl };
    const granted = h.requestPermission(permission, details);
    assert.notEqual(granted, undefined, `the ${permission} request was answered`);
    assert.equal(h.checkPermission(permission, details), granted, `check and request disagree on ${permission}`);
    return granted === true;
  }

  it("grants a clipboard write to the web UI's main frame and to the bundled wizard", () => {
    // The copy buttons: an API key's token, a device-login code, the recovery key.
    assert.equal(decide(CLIPBOARD_WRITE, `${UI}/admin/api-keys`, true), true);
    assert.equal(decide(CLIPBOARD_WRITE, `${KERNEL}/health`, true), true);
    assert.equal(decide(CLIPBOARD_WRITE, WIZARD, true), true);
    assert.deepEqual(h.logged, [], 'a granted request is not logged');
  });

  it("refuses it to a subframe, a plugin UI on the web UI's own origin included", () => {
    assert.equal(decide(CLIPBOARD_WRITE, `${UI}/p/synthetic-plugin/ui/index.html`, false), false);
    assert.equal(decide(CLIPBOARD_WRITE, 'https://maps.example/embed?q=synthetic', false), false);
  });

  it("refuses it to a main frame that is not the app's own document", () => {
    for (const url of [
      IDP_PAGE,
      'https://evil.example/',
      'http://127.0.0.1:9999/',
      LOADING,
      pathToFileURL(path.resolve('/tmp/synthetic/wizard.html')).href,
      'about:blank',
    ]) {
      assert.equal(decide(CLIPBOARD_WRITE, url, true), false, url);
    }
  });

  it("refuses every other permission, even to the web UI's main frame and the wizard", () => {
    for (const permission of [
      'media',
      'display-capture',
      'geolocation',
      'notifications',
      'fullscreen',
      'clipboard-read',
      'midi',
      'hid',
      'serial',
      'pointerLock',
    ]) {
      assert.equal(decide(permission, `${UI}/chat`, true), false, permission);
      assert.equal(decide(permission, WIZARD, true), false, permission);
    }
  });

  it('refuses openExternal and the deprecated synchronous clipboard read to the app itself', () => {
    for (const permission of ['openExternal', 'deprecated-sync-clipboard-read']) {
      assert.equal(decide(permission, `${UI}/chat`, true), false, permission);
      assert.equal(decide(permission, WIZARD, true), false, permission);
    }
  });

  it('judges a request without a requesting URL by the document in the window', () => {
    h.current = `${UI}/chat`;
    assert.equal(decide(CLIPBOARD_WRITE, undefined, true), true);
    h.current = IDP_PAGE;
    assert.equal(decide(CLIPBOARD_WRITE, undefined, true), false);
    h.current = `${UI}/chat`;
    h.getUrlThrows = true;
    assert.equal(decide(CLIPBOARD_WRITE, undefined, true), false, 'a destroyed window shows nothing of the app');
    h.getUrlThrows = false;
    h.handlerContents = null;
    assert.equal(decide(CLIPBOARD_WRITE, undefined, true), false, 'no window, no document');
  });

  it('judges by the frame that asked, not by what the window shows', () => {
    h.current = `${UI}/chat`;
    assert.equal(decide(CLIPBOARD_WRITE, IDP_PAGE, true), false);
  });

  it('reads the trust set per request', () => {
    h.trusted = { origins: [KERNEL] };
    assert.equal(decide(CLIPBOARD_WRITE, `${UI}/chat`, true), false, 'no web UI is serving yet');
    h.trusted = { origins: [KERNEL, UI] };
    assert.equal(decide(CLIPBOARD_WRITE, `${UI}/chat`, true), true);
  });

  it('logs each refused request with its permission, origin and frame kind, and no check', () => {
    h.requestPermission('media', {
      isMainFrame: false,
      requestingUrl: `${UI}/p/synthetic-plugin/ui/index.html?token=synthetic-secret`,
    });
    h.requestPermission('geolocation', { isMainFrame: true, requestingUrl: 'https://evil.example/path?q=synthetic-secret' });
    h.requestPermission(CLIPBOARD_WRITE, { isMainFrame: true, requestingUrl: WIZARD });
    h.checkPermission('notifications', { isMainFrame: true, requestingUrl: 'https://evil.example/' });
    assert.deepEqual(h.logged, [
      `WARN [nav] refused media for ${UI} (subframe)`,
      'WARN [nav] refused geolocation for https://evil.example (main frame)',
    ]);
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
