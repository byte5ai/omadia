/**
 * Where the shell's windows may go (the pure half of the navigation guards).
 *
 * Nothing restricted navigation before: a link in a chat answer, an IdP logout
 * URL or a plugin author's homepage replaced the web UI in the app window and
 * kept the preload bridge, and `target="_blank"` opened unvetted Electron
 * windows. The policy now keeps the window on the app's own loopback origins,
 * sends other web links to the system browser, and refuses every other scheme,
 * `file:` included.
 */
import { describe, it, before } from 'node:test';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  decideNavigation,
  decideNavigationFrom,
  isSafeForExternalOpen,
  originOf,
  trustedTargetsFor,
  type TrustedTargets,
} from '../src/navigationPolicy.ts';
import { Supervisor } from '../src/supervisor.ts';

const UI = 'http://127.0.0.1:4567';
const KERNEL = 'http://127.0.0.1:8769';
const TRUSTED: TrustedTargets = { origins: [KERNEL, UI] };
const RENDERER = path.resolve('/opt/omadia/resources/app.asar/dist/renderer');
const WIZARD = `${pathToFileURL(path.join(RENDERER, 'wizard.html')).href}?log=x#recovered`;
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
