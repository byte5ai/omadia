/**
 * Main's check on who may call which IPC channel.
 *
 * Every handler in `ipc.ts` used to answer any sender, so the recovery-key
 * export returned the vault master key to whatever document was in the window:
 * the web UI, a same-origin plugin iframe calling through `window.parent.omadia`
 * (which arrives from the MAIN frame with the web UI's origin), or a foreign
 * page reached by a redirect. `decideSender` is the boundary now: the setup
 * channels answer only the bundled wizard page, in the main frame, while the
 * navigator shows the wizard; the UI channels answer only the web UI's origin.
 *
 * Synthetic values only; no Electron.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  decideSender,
  isBundledPage,
  readSenderFacts,
  samePath,
  type SenderContext,
  type SenderFacts,
} from '../src/ipcSender.ts';

const RENDERER = path.resolve('/opt/omadia/resources/app.asar/dist/renderer');
const UI = 'http://127.0.0.1:4567';
const KERNEL = 'http://127.0.0.1:8769';

const WIZARD = pathToFileURL(path.join(RENDERER, 'wizard.html')).href;
const WIZARD_AS_LOADED = `${WIZARD}?log=${encodeURIComponent('/tmp/omadia.log')}#recovered`;
const LOADING = `${pathToFileURL(path.join(RENDERER, 'loading.html')).href}?log=x`;

/** A main frame at `url`; file: and about: pages have the opaque origin "null". */
function mainFrame(url: string, origin = originOf(url)): SenderFacts {
  return { frameUrl: url, frameOrigin: origin, isMainFrame: true };
}

function subframe(url: string): SenderFacts {
  return { ...mainFrame(url), isMainFrame: false };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'null';
  }
}

/** The shell during first-run setup: the wizard is up, no web UI serves yet. */
const DURING_SETUP: SenderContext = { rendererDir: RENDERER, appOrigin: null, view: 'wizard' };
/** The shell after boot: the web UI is on screen. */
const RUNNING: SenderContext = { rendererDir: RENDERER, appOrigin: UI, view: 'app' };

describe('decideSender — setup channels (wizard surface)', () => {
  it('answers the bundled wizard page in the main frame during setup', () => {
    assert.deepEqual(decideSender('wizard', mainFrame(WIZARD_AS_LOADED), DURING_SETUP), {
      allowed: true,
    });
    assert.equal(decideSender('wizard', mainFrame(WIZARD), DURING_SETUP).allowed, true);
  });

  it('refuses the web UI itself', () => {
    const decision = decideSender('wizard', mainFrame(`${UI}/chat`), RUNNING);
    assert.equal(decision.allowed, false);
    assert.match(String(decision.reason), /not the bundled wizard page/);
  });

  it('refuses a same-origin plugin iframe calling through window.parent.omadia', () => {
    // The call goes out through the PARENT's bridge, so Electron reports the
    // main frame with the web UI's origin: the main-frame rule cannot catch it,
    // the page rule must.
    const viaParentBridge = mainFrame(`${UI}/plugin-ui/some-plugin`);
    assert.equal(decideSender('wizard', viaParentBridge, RUNNING).allowed, false);
  });

  it('refuses the web UI while the navigator has already claimed the wizard view', () => {
    // `startNavigation` claims the view before wizard.html has loaded, so the
    // previous document is still on screen with view === 'wizard'. Only the
    // page check protects the setup channels in that window.
    const claimed: SenderContext = { rendererDir: RENDERER, appOrigin: UI, view: 'wizard' };
    assert.equal(decideSender('wizard', mainFrame(`${UI}/chat`), claimed).allowed, false);
    assert.equal(decideSender('wizard', mainFrame('https://evil.example/'), claimed).allowed, false);
  });

  it('refuses foreign and opaque documents', () => {
    for (const url of ['https://evil.example/', 'https://login.microsoftonline.com/common/login', 'about:blank', 'data:text/html,x']) {
      assert.equal(decideSender('wizard', mainFrame(url), DURING_SETUP).allowed, false, url);
    }
  });

  it('refuses the loading screen', () => {
    assert.equal(decideSender('wizard', mainFrame(LOADING), DURING_SETUP).allowed, false);
  });

  it('refuses a wizard.html that is not the bundled one', () => {
    const lookalike = pathToFileURL('/Users/x/Downloads/wizard.html').href;
    const decision = decideSender('wizard', mainFrame(lookalike), DURING_SETUP);
    assert.equal(decision.allowed, false);
    assert.match(String(decision.reason), /not the bundled wizard page/);
  });

  it('refuses a path that climbs out of the renderer directory', () => {
    const climbing = `${pathToFileURL(RENDERER).href}/../../wizard.html`;
    assert.equal(decideSender('wizard', mainFrame(climbing), DURING_SETUP).allowed, false);
    const encoded = `${pathToFileURL(RENDERER).href}/%2e%2e/%2e%2e/wizard.html`;
    assert.equal(decideSender('wizard', mainFrame(encoded), DURING_SETUP).allowed, false);
  });

  it('refuses the real wizard page once first-run setup is over', () => {
    for (const view of ['app', 'boot'] as const) {
      const decision = decideSender('wizard', mainFrame(WIZARD_AS_LOADED), { ...RUNNING, view });
      assert.equal(decision.allowed, false, view);
      assert.match(String(decision.reason), new RegExp(`outside first-run setup \\(view=${view}\\)`));
    }
  });

  it('refuses a vanished sender frame and a subframe', () => {
    const gone = decideSender('wizard', { frameUrl: null, frameOrigin: null, isMainFrame: false }, DURING_SETUP);
    assert.equal(gone.allowed, false);
    assert.match(String(gone.reason), /sender frame gone/);
    const nested = decideSender('wizard', subframe(WIZARD), DURING_SETUP);
    assert.equal(nested.allowed, false);
    assert.match(String(nested.reason), /not the main frame/);
  });

  it('gives each kind of refusal its own reason, and never logs the query', () => {
    const reasons = [
      decideSender('wizard', { frameUrl: null, frameOrigin: null, isMainFrame: false }, DURING_SETUP),
      decideSender('wizard', subframe(WIZARD), DURING_SETUP),
      decideSender('wizard', mainFrame(`${UI}/chat?token=synthetic`), RUNNING),
      decideSender('wizard', mainFrame(WIZARD_AS_LOADED), RUNNING),
    ].map((d) => String(d.reason));
    assert.equal(new Set(reasons.map((r) => r.split(' (')[0])).size, reasons.length, reasons.join(' | '));
    assert.ok(!reasons.some((r) => r.includes('token=synthetic')), 'a query can carry a credential');
    assert.match(reasons[2] ?? '', new RegExp(`expected ${WIZARD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });
});

describe('decideSender — UI channels (app surface)', () => {
  it("answers the web UI's own main frame", () => {
    assert.deepEqual(decideSender('app', mainFrame(`${UI}/chat`), RUNNING), { allowed: true });
  });

  it('refuses everything while no web UI is serving', () => {
    const decision = decideSender('app', mainFrame(`${UI}/chat`), { ...RUNNING, appOrigin: null });
    assert.equal(decision.allowed, false);
    assert.match(String(decision.reason), /no web UI is serving/);
  });

  it('refuses a foreign origin, the kernel origin and the opaque origin of a file page', () => {
    for (const facts of [
      mainFrame('https://evil.example/'),
      mainFrame(`${KERNEL}/api/v1/auth/login/entra/cb`),
      mainFrame('http://127.0.0.1:9999/'),
      mainFrame(WIZARD_AS_LOADED),
    ]) {
      assert.equal(decideSender('app', facts, RUNNING).allowed, false, String(facts.frameUrl));
    }
  });

  it('refuses a subframe even at the web UI origin', () => {
    assert.equal(decideSender('app', subframe(`${UI}/chat`), RUNNING).allowed, false);
  });

  it('refuses a foreign main frame on both surfaces', () => {
    const foreign = mainFrame('https://login.microsoftonline.com/common/login');
    assert.equal(decideSender('app', foreign, RUNNING).allowed, false);
    assert.equal(decideSender('wizard', foreign, RUNNING).allowed, false);
  });
});

describe('readSenderFacts — a frame that is gone fails closed', () => {
  const live = { url: `${UI}/chat`, origin: UI, parent: null, detached: false, isDestroyed: () => false };

  it('reads a live main frame', () => {
    assert.deepEqual(readSenderFacts({ senderFrame: live }), {
      frameUrl: `${UI}/chat`,
      frameOrigin: UI,
      isMainFrame: true,
    });
  });

  it('reports a frame with a parent as a subframe', () => {
    assert.equal(readSenderFacts({ senderFrame: { ...live, parent: live } }).isMainFrame, false);
  });

  it('treats a null, missing, destroyed, detached or unreadable frame as gone', () => {
    const disposed = {
      get url(): string {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      },
      origin: UI,
      parent: null,
    };
    const throwingEvent = {
      get senderFrame(): never {
        throw new Error('synthetic');
      },
    };
    const gone = [
      { senderFrame: null },
      {},
      { senderFrame: { ...live, isDestroyed: () => true } },
      { senderFrame: { ...live, detached: true } },
      { senderFrame: disposed },
      throwingEvent,
    ];
    for (const event of gone) {
      const facts = readSenderFacts(event);
      assert.equal(facts.frameUrl, null);
      assert.equal(decideSender('app', facts, RUNNING).allowed, false);
      assert.equal(decideSender('wizard', facts, DURING_SETUP).allowed, false);
    }
  });
});

describe('isBundledPage', () => {
  it('matches the page by file path, ignoring query and hash', () => {
    assert.equal(isBundledPage(WIZARD_AS_LOADED, RENDERER, 'wizard.html'), true);
    assert.equal(isBundledPage(WIZARD, `${RENDERER}${path.sep}`, 'wizard.html'), true);
  });

  it('rejects another page, another directory, another scheme and garbage', () => {
    assert.equal(isBundledPage(LOADING, RENDERER, 'wizard.html'), false);
    assert.equal(isBundledPage(pathToFileURL('/tmp/wizard.html').href, RENDERER, 'wizard.html'), false);
    assert.equal(isBundledPage(`${UI}/wizard.html`, RENDERER, 'wizard.html'), false);
    assert.equal(isBundledPage('not a url', RENDERER, 'wizard.html'), false);
  });

  it('rejects a file URL with a host and one with an encoded slash', () => {
    const hosted = WIZARD.replace('file:///', 'file://evil-host/');
    assert.equal(isBundledPage(hosted, RENDERER, 'wizard.html'), false);
    const slashed = `${pathToFileURL(RENDERER).href}/sub%2F..%2Fwizard.html`;
    assert.equal(isBundledPage(slashed, RENDERER, 'wizard.html'), false);
  });
});

describe('samePath', () => {
  it('ignores case on Windows only', () => {
    const a = 'C:\\Program Files\\omadia\\resources\\app.asar\\dist\\renderer\\wizard.html';
    const b = 'c:\\program files\\omadia\\resources\\app.asar\\dist\\renderer\\WIZARD.html';
    assert.equal(samePath(a, b, 'win32'), true);
    assert.equal(samePath(a, b, 'darwin'), false);
    assert.equal(samePath('/opt/a', '/opt/a', 'linux'), true);
  });
});
