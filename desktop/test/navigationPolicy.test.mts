/**
 * Where the shell's windows may go (the pure half of the navigation guards).
 *
 * Nothing restricted navigation before: a link in a chat answer, an IdP logout
 * URL or a plugin author's homepage replaced the web UI in the app window and
 * kept the preload bridge, and `target="_blank"` opened unvetted Electron
 * windows. The policy now keeps the window on the app's own loopback origins,
 * sends other web links to the system browser, and refuses every other scheme,
 * `file:` included. Subframes and server redirects may not reach the OS
 * protocol handler either. Session permissions are deny by default: only an
 * allowlisted one, asked for by a main frame showing the app's own document,
 * is granted, and the `openExternal` permission that Electron asks before
 * handing a URL to the OS never is.
 */
import { describe, it, before } from 'node:test';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  GRANTABLE_PERMISSIONS,
  canGrantPermission,
  canRedirectTo,
  canSubframeLoad,
  decideNavigation,
  decideNavigationFrom,
  isSafeForExternalOpen,
  originOf,
  trustedTargetsFor,
  type AppDocuments,
  type PermissionRequester,
  type TrustedTargets,
} from '../src/navigationPolicy.ts';
import { Supervisor } from '../src/supervisor.ts';

const UI = 'http://127.0.0.1:4567';
const KERNEL = 'http://127.0.0.1:8769';
const TRUSTED: TrustedTargets = { origins: [KERNEL, UI] };
const RENDERER = path.resolve('/opt/omadia/resources/app.asar/dist/renderer');
const WIZARD = `${pathToFileURL(path.join(RENDERER, 'wizard.html')).href}?log=x#recovered`;
const LOADING = `${pathToFileURL(path.join(RENDERER, 'loading.html')).href}?log=x`;
const IDP_PAGE = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=synthetic';

describe('decideNavigation', () => {
  it("keeps the app's own loopback origins in the window", () => {
    for (const url of [`${UI}/anything?x=1`, `${UI}/login`, `${KERNEL}/api/v1/auth/login/entra/cb?code=synthetic`]) {
      assert.equal(decideNavigation(url, TRUSTED), 'allow', url);
    }
  });

  it('sends every other web link to the system browser', () => {
    for (const url of [
      'https://github.com/byte5ai/omadia',
      'https://127.0.0.1.evil.example/',
      'http://127.0.0.1@evil.example/',
      'http://127.0.0.1:9999/',
      'https://127.0.0.1:4567/',
      'http://localhost:4567/',
      IDP_PAGE,
    ]) {
      assert.equal(decideNavigation(url, TRUSTED), 'open-external', url);
    }
  });

  it('refuses every other scheme, file: included', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<p>synthetic</p>',
      `blob:${UI}/5d9c7c2e-0000-4000-8000-000000000000`,
      'about:blank',
      'file:///etc/passwd',
      `${pathToFileURL(RENDERER).href}/../../package.json`,
      WIZARD,
      'mailto:someone@example.com',
      'omadia-custom://open',
      'not a url',
      '',
    ]) {
      assert.equal(decideNavigation(url, TRUSTED), 'deny', url);
    }
  });

  it('trusts nothing but the kernel before the web UI is up', () => {
    const booting = trustedTargetsFor(KERNEL, null);
    assert.deepEqual(booting, { origins: [KERNEL] });
    assert.equal(decideNavigation(`${UI}/chat`, booting), 'open-external');
    assert.equal(decideNavigation(`${UI}/chat`, trustedTargetsFor(KERNEL, `${UI}/`)), 'allow');
  });
});

describe('decideNavigationFrom — the current document decides', () => {
  it('applies the policy to navigations from the app, the bundled pages and a blank window', () => {
    for (const current of [`${UI}/chat`, `${KERNEL}/health`, WIZARD, 'about:blank', '']) {
      assert.equal(decideNavigationFrom(current, 'https://evil.example/', TRUSTED), 'open-external', current);
      assert.equal(decideNavigationFrom(current, `${UI}/chat`, TRUSTED), 'allow', current);
      assert.equal(decideNavigationFrom(current, 'file:///etc/passwd', TRUSTED), 'deny', current);
    }
  });

  it('diverts a link in an assistant answer and the IdP logout to the system browser', () => {
    assert.equal(decideNavigationFrom(`${UI}/chat`, 'https://example.com/docs', TRUSTED), 'open-external');
    assert.equal(
      decideNavigationFrom(`${UI}/chat`, 'https://login.microsoftonline.com/common/oauth2/v2.0/logout', TRUSTED),
      'open-external',
    );
  });

  it("lets an IdP page reached by a redirect run its own sign-in steps in the window", () => {
    assert.equal(decideNavigationFrom(IDP_PAGE, 'https://login.microsoftonline.com/common/login', TRUSTED), 'allow');
    assert.equal(decideNavigationFrom(IDP_PAGE, 'https://login.live.com/ppsecure/post.srf', TRUSTED), 'allow');
    assert.equal(decideNavigationFrom(IDP_PAGE, `${KERNEL}/api/v1/auth/login/entra/cb?code=synthetic`, TRUSTED), 'allow');
  });

  it('still refuses script, data and file targets from a foreign page', () => {
    for (const target of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', WIZARD, 'not a url']) {
      assert.equal(decideNavigationFrom(IDP_PAGE, target, TRUSTED), 'deny', target);
    }
  });
});

/** Schemes the OS hands to an installed program; none may be reached from a page. */
const OS_HANDLED = [
  'ms-settings:privacy',
  'search-ms:query=synthetic',
  'facetime:+15550100',
  'omadia-custom://open',
  'mailto:someone@example.com',
];

describe('canSubframeLoad — iframes stay inside the page', () => {
  it('lets a subframe show any web page, as in a browser', () => {
    for (const url of [
      `${UI}/p/synthetic-plugin/ui/index.html?theme=dark`,
      `${UI}/bot-api/v1/builder/drafts/synthetic/preview`,
      'https://maps.example/embed?q=synthetic',
      'http://example.com/',
    ]) {
      assert.equal(canSubframeLoad(url), true, url);
    }
  });

  it('lets a subframe show what the browser renders itself', () => {
    for (const url of [
      'about:srcdoc',
      'about:blank',
      'data:text/html,<p>synthetic</p>',
      `blob:${UI}/5d9c7c2e-0000-4000-8000-000000000000`,
    ]) {
      assert.equal(canSubframeLoad(url), true, url);
    }
  });

  it('refuses anything that would reach the OS protocol handler, and files', () => {
    for (const url of [...OS_HANDLED, 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', '']) {
      assert.equal(canSubframeLoad(url), false, url);
    }
  });
});

describe('canRedirectTo — server redirects in any frame', () => {
  it('lets web redirects through, the in-window sign-in is a chain of them', () => {
    for (const url of [IDP_PAGE, `${KERNEL}/api/v1/auth/login/entra/cb?code=synthetic`, 'https://evil.example/']) {
      assert.equal(canRedirectTo(url), true, url);
    }
  });

  it('refuses a redirect to any other scheme', () => {
    for (const url of [...OS_HANDLED, 'file:///etc/passwd', 'data:text/html,x', 'about:blank', 'not a url', '']) {
      assert.equal(canRedirectTo(url), false, url);
    }
  });
});

/**
 * Without a handler Electron grants every permission (camera, microphone,
 * location, notifications, ...) to every frame: plugin iframes, same-app
 * popups and a foreign page reached by a redirect included. Now a page gets
 * only what is on the allowlist, and only in the main frame of one of the
 * app's own documents. Requests and checks share this one rule.
 */
describe('session permissions — deny by default, an allowlist for the app\'s own main frames', () => {
  const APP: AppDocuments = { trusted: TRUSTED, rendererDir: RENDERER };
  const CLIPBOARD_WRITE = 'clipboard-sanitized-write';
  const mainFrame = (url: string): PermissionRequester => ({ url, isMainFrame: true });
  const subframe = (url: string): PermissionRequester => ({ url, isMainFrame: false });

  it("allows only what the app's own pages use: the clipboard write behind their copy buttons", () => {
    // `navigator.clipboard.writeText` in the web UI and the wizard. Anything
    // added here needs a call site, and a test that names it.
    assert.deepEqual([...GRANTABLE_PERMISSIONS], [CLIPBOARD_WRITE]);
  });

  it('grants it to the main frame of the web UI, the kernel and the bundled wizard', () => {
    for (const url of [`${UI}/admin/api-keys`, `${UI}/memories/synthetic?x=1#y`, `${KERNEL}/health`, WIZARD]) {
      assert.equal(canGrantPermission(CLIPBOARD_WRITE, mainFrame(url), APP), true, url);
    }
  });

  it("refuses it to every subframe, a plugin UI on the web UI's own origin included", () => {
    for (const url of [
      `${UI}/p/synthetic-plugin/ui/index.html?theme=dark`,
      `${UI}/bot-api/v1/builder/drafts/synthetic/preview`,
      WIZARD,
      'https://maps.example/embed?q=synthetic',
    ]) {
      assert.equal(canGrantPermission(CLIPBOARD_WRITE, subframe(url), APP), false, url);
    }
  });

  it('refuses it to a main frame showing anything else', () => {
    for (const url of [
      IDP_PAGE,
      'https://evil.example/',
      'http://127.0.0.1:9999/',
      'https://127.0.0.1:4567/',
      'http://localhost:4567/',
      'http://127.0.0.1.evil.example:4567/',
      // Bundled, but it copies nothing.
      LOADING,
      // A `wizard.html` anywhere but the install, also by dot segments.
      pathToFileURL(path.resolve('/tmp/synthetic/wizard.html')).href,
      `${pathToFileURL(RENDERER).href}/../wizard.html`,
      'about:blank',
      'data:text/html,<p>synthetic</p>',
      `blob:${UI}/5d9c7c2e-0000-4000-8000-000000000000`,
      'not a url',
      '',
    ]) {
      assert.equal(canGrantPermission(CLIPBOARD_WRITE, mainFrame(url), APP), false, url);
    }
  });

  it("refuses every other permission, even to the web UI's main frame and the wizard", () => {
    for (const permission of [
      'media',
      'display-capture',
      'geolocation',
      'notifications',
      'fullscreen',
      'pointerLock',
      'keyboardLock',
      'clipboard-read',
      'midi',
      'midiSysex',
      'hid',
      'serial',
      'usb',
      'idle-detection',
      'storage-access',
      'window-management',
      'fileSystem',
      'background-sync',
      'local-network-access',
      'unknown',
    ]) {
      for (const url of [`${UI}/chat`, WIZARD]) {
        assert.equal(canGrantPermission(permission, mainFrame(url), APP), false, `${permission} for ${url}`);
      }
    }
  });

  it('never grants openExternal or the deprecated synchronous clipboard read', () => {
    // Electron asks for openExternal before handing a non-web URL to the OS
    // protocol handler; the shell opens vetted web links itself.
    for (const permission of ['openExternal', 'deprecated-sync-clipboard-read']) {
      for (const requester of [mainFrame(`${UI}/chat`), mainFrame(WIZARD), mainFrame(IDP_PAGE), subframe(`${UI}/chat`)]) {
        assert.equal(canGrantPermission(permission, requester, APP), false, `${permission} for ${requester.url}`);
      }
    }
  });

  it('trusts the web UI only while it is serving', () => {
    const booting: AppDocuments = { trusted: trustedTargetsFor(KERNEL, null), rendererDir: RENDERER };
    assert.equal(canGrantPermission(CLIPBOARD_WRITE, mainFrame(`${UI}/chat`), booting), false);
    assert.equal(canGrantPermission(CLIPBOARD_WRITE, mainFrame(WIZARD), booting), true);
  });
});

describe('isSafeForExternalOpen', () => {
  it('accepts web URLs only', () => {
    assert.equal(isSafeForExternalOpen('https://github.com/byte5ai/omadia'), true);
    assert.equal(isSafeForExternalOpen('http://example.com/'), true);
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'smb://host/share', 'ms-settings:privacy', 'not a url', '']) {
      assert.equal(isSafeForExternalOpen(url), false, url);
    }
  });
});

describe('originOf', () => {
  it('reads the origin of a web URL and nothing else', () => {
    assert.equal(originOf(`${UI}/chat?x=1#y`), UI);
    assert.equal(originOf(null), null);
    assert.equal(originOf('not a url'), null);
    assert.equal(originOf('file:///tmp/x.html'), null);
    assert.equal(originOf('about:blank'), null);
  });
});

/**
 * The in-window sign-in only works if every URL the kernel is told to send the
 * browser back to is a trusted origin; otherwise the last hop of an Entra login
 * would be diverted to the system browser. Builds the kernel env the way
 * `bootOnce` does and checks it against the trust set `main.ts` uses.
 */
describe('the kernel only sends the window back to trusted origins', () => {
  before(() => {
    // Same shim as supervisorKernelEnv.test.mts: `paths.ts` reads `__dirname`.
    (globalThis as { __dirname?: string }).__dirname = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'dist',
    );
  });

  it('allows the Entra callback, the diagram base, the public base and the MCP callback', () => {
    const uiPort = 51_234;
    const kernelPort = Number(new URL(Supervisor.kernelOrigin()).port);
    type WithKernelEnv = { kernelEnv(port: number, uiPort: number): NodeJS.ProcessEnv };
    const env = (new Supervisor() as unknown as WithKernelEnv).kernelEnv(kernelPort, uiPort);
    const trusted = trustedTargetsFor(Supervisor.kernelOrigin(), `http://127.0.0.1:${uiPort}`);
    for (const key of ['AUTH_REDIRECT_URI', 'DIAGRAM_PUBLIC_BASE_URL', 'PUBLIC_BASE_URL', 'MCP_OAUTH_REDIRECT_URI']) {
      const url = env[key];
      assert.ok(url, `${key} must be set`);
      assert.equal(decideNavigation(url, trusted), 'allow', `${key}=${url}`);
    }
  });

  it('pins the kernel origin to the fixed loopback port', () => {
    assert.equal(Supervisor.kernelOrigin(), KERNEL);
  });
});
