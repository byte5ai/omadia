/**
 * The IPC channels as `registerIpc` really registers them.
 *
 * The recording `ipcMain` captures every handler and listener, and each one is
 * called with a synthetic event the way Electron calls it. So this pins the
 * wiring, not a reimplementation: a channel registered without the sender
 * check, or with the wrong surface, answers the web UI here and goes red.
 *
 * Order matters in this file: the refusals run first and prove that nothing
 * was written (no secrets file, no setup.json); the legitimate wizard flow
 * runs last because it does write.
 */
import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// The stub loader redirects `electron` to the fake; `app.getPath` is its temp dir.
import { app, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';

import {
  __setIpcMain,
  __setOpenDialogHandler,
  type FakeInvokeHandler,
  type FakeOnListener,
} from './helpers/electron-fake.mjs';
import { registerIpc } from '../src/ipc.ts';
import { CH, type WizardConfig } from '../src/ipcTypes.ts';
import { secretsFile, setupFile } from '../src/paths.ts';
import type { ShellView } from '../src/shellView.ts';

const RENDERER = path.resolve('/fake/dist/renderer');
const UI = 'http://127.0.0.1:4567';
const WIZARD_URL = `${pathToFileURL(path.join(RENDERER, 'wizard.html')).href}?log=x`;
const REFUSED = /not available from here/;

interface FakeFrame {
  readonly url: string;
  readonly origin: string;
  readonly parent: FakeFrame | null;
  readonly detached: boolean;
  isDestroyed(): boolean;
}

function frame(url: string, opts: { parent?: FakeFrame; destroyed?: boolean; detached?: boolean } = {}): FakeFrame {
  let origin = 'null';
  try {
    origin = new URL(url).origin;
  } catch {
    /* opaque */
  }
  return {
    url,
    origin,
    parent: opts.parent ?? null,
    detached: opts.detached ?? false,
    isDestroyed: () => opts.destroyed ?? false,
  };
}

const WEB_UI = frame(`${UI}/chat`);
const FOREIGN = frame('https://evil.example/');
const WIZARD = frame(WIZARD_URL);

/** What Electron hands a listener; `sender` is what `complete` streams progress to. */
function eventFrom(senderFrame: FakeFrame | null): IpcMainInvokeEvent & IpcMainEvent {
  const sender = { isDestroyed: () => false, send: () => undefined, mainFrame: senderFrame };
  return { sender, senderFrame } as unknown as IpcMainInvokeEvent & IpcMainEvent;
}

const handlers = new Map<string, FakeInvokeHandler>();
const listeners = new Map<string, FakeOnListener>();
let view: ShellView = 'app';
let appOrigin: string | null = UI;
const calls = { boot: 0, ready: [] as string[], uiReady: 0, uiLocale: [] as unknown[] };

async function invoke(channel: string, senderFrame: FakeFrame | null, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  assert.ok(handler, `${channel} is registered`);
  return handler(eventFrom(senderFrame), ...args);
}

function emit(channel: string, senderFrame: FakeFrame | null, ...args: unknown[]): void {
  const listener = listeners.get(channel);
  assert.ok(listener, `${channel} is registered`);
  listener(eventFrom(senderFrame), ...args);
}

const SETUP: WizardConfig = {
  provider: 'subscription',
  apiKey: '',
  capabilities: { attachments: true },
  dataDir: null,
};

function assertNothingWritten(): void {
  assert.equal(fs.existsSync(secretsFile()), false, 'no secrets file');
  assert.equal(fs.existsSync(setupFile()), false, 'no setup.json');
  assert.equal(calls.boot, 0, 'the stack was not booted');
}

before(() => {
  __setIpcMain({
    handle: (channel, handler) => {
      handlers.set(channel, handler);
    },
    on: (channel, listener) => {
      listeners.set(channel, listener);
    },
  });
  registerIpc({
    boot: async () => {
      calls.boot += 1;
      return UI;
    },
    onReady: (uiUrl) => calls.ready.push(uiUrl),
    onUiReady: () => {
      calls.uiReady += 1;
    },
    onUiLocale: (locale) => calls.uiLocale.push(locale),
    currentView: () => view,
    appOrigin: () => appOrigin,
    rendererDir: RENDERER,
  });
});

after(() => __setIpcMain(null));

describe('registerIpc — what is registered', () => {
  it('registers the four setup channels and the two UI pings, and no getState', () => {
    assert.deepEqual([...handlers.keys()].sort(), [
      CH.chooseDataDir,
      CH.complete,
      CH.exportRecoveryKey,
      CH.testLlmKey,
    ].sort());
    assert.deepEqual([...listeners.keys()].sort(), [CH.uiLocale, CH.uiReady].sort());
    assert.equal(handlers.has('omadia:getState'), false);
  });
});

describe('registerIpc — the recovery key and setup stay with the wizard', () => {
  it('refuses the recovery-key export to the web UI', async () => {
    view = 'app';
    appOrigin = UI;
    await assert.rejects(invoke(CH.exportRecoveryKey, WEB_UI), REFUSED);
    assertNothingWritten();
  });

  it('refuses it to a same-origin plugin iframe calling through the parent bridge', async () => {
    // The parent's bridge sends from the MAIN frame with the web UI's origin,
    // and the navigator may already claim the wizard view while it is on screen.
    for (const claimed of ['app', 'wizard'] as const) {
      view = claimed;
      await assert.rejects(invoke(CH.exportRecoveryKey, frame(`${UI}/plugin-ui/some-plugin`)), REFUSED, claimed);
    }
    assertNothingWritten();
  });

  it('refuses it to a foreign document, a vanished frame, a destroyed frame and a detached frame', async () => {
    view = 'wizard';
    const refused = [
      FOREIGN,
      null,
      frame(WIZARD_URL, { destroyed: true }),
      frame(WIZARD_URL, { detached: true }),
      frame(WIZARD_URL, { parent: WEB_UI }),
    ];
    for (const sender of refused) {
      await assert.rejects(invoke(CH.exportRecoveryKey, sender), REFUSED, sender?.url ?? 'null frame');
    }
    assertNothingWritten();
  });

  it('refuses it to the real wizard page once setup is over', async () => {
    for (const later of ['app', 'boot'] as const) {
      view = later;
      await assert.rejects(invoke(CH.exportRecoveryKey, WIZARD), REFUSED, later);
    }
    assertNothingWritten();
  });

  it('refuses the wizard the key of a folder the picker did not return', async () => {
    view = 'wizard';
    // Another folder's secrets: the channel must not become a way to read them.
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-ipc-elsewhere-'));
    const blob = { vaultKey: Buffer.alloc(32, 5).toString('base64'), providerKeys: {} };
    const bytes = Buffer.from(JSON.stringify(blob), 'utf8');
    fs.writeFileSync(path.join(elsewhere, 'secrets.enc'), bytes, { mode: 0o600 });
    for (const requested of [elsewhere, undefined, '', 42, { dataDir: elsewhere }]) {
      await assert.rejects(
        invoke(CH.exportRecoveryKey, WIZARD, requested),
        /not chosen in this setup/,
        String(requested),
      );
    }
    assert.deepEqual(fs.readFileSync(path.join(elsewhere, 'secrets.enc')), bytes);
    assertNothingWritten();
  });

  it('refuses setup completion to the web UI without writing or booting anything', async () => {
    view = 'app';
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-ipc-elsewhere-'));
    await assert.rejects(invoke(CH.complete, WEB_UI, { ...SETUP, dataDir: elsewhere }), REFUSED);
    assertNothingWritten();
    assert.equal(fs.existsSync(path.join(app.getPath('userData'), 'datadir.txt')), false, 'data dir unchanged');
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    assert.deepEqual(calls.ready, []);
  });

  it('refuses every invoke channel to a foreign document, in every view', async () => {
    for (const current of ['wizard', 'boot', 'app'] as const) {
      view = current;
      for (const channel of handlers.keys()) {
        await assert.rejects(invoke(channel, FOREIGN, SETUP), REFUSED, `${channel} in ${current}`);
      }
    }
    assertNothingWritten();
  });

  it('refuses every setup channel to the web UI', async () => {
    view = 'app';
    for (const channel of [CH.testLlmKey, CH.chooseDataDir, CH.exportRecoveryKey, CH.complete]) {
      await assert.rejects(invoke(channel, WEB_UI, SETUP), REFUSED, channel);
    }
    assertNothingWritten();
  });
});

describe('registerIpc — the UI pings answer the web UI only', () => {
  it('drops a locale push from a foreign document and a subframe, delivers the web UI one', () => {
    view = 'app';
    appOrigin = UI;
    emit(CH.uiLocale, FOREIGN, 'de');
    emit(CH.uiLocale, frame(`${UI}/chat`, { parent: WEB_UI }), 'de');
    emit(CH.uiLocale, WIZARD, 'de');
    assert.deepEqual(calls.uiLocale, []);
    emit(CH.uiLocale, WEB_UI, 'de');
    assert.deepEqual(calls.uiLocale, ['de']);
  });

  it('drops a ready ping from elsewhere and after the stack stopped', () => {
    const before = calls.uiReady;
    emit(CH.uiReady, FOREIGN);
    emit(CH.uiReady, null);
    appOrigin = null;
    emit(CH.uiReady, WEB_UI);
    assert.equal(calls.uiReady, before);
    appOrigin = UI;
    emit(CH.uiReady, WEB_UI);
    assert.equal(calls.uiReady, before + 1);
  });
});

describe('registerIpc — the legitimate wizard flow still works', () => {
  it('tests a key for the wizard', async () => {
    view = 'wizard';
    appOrigin = null;
    // Too short to reach the network: the check answers before any fetch.
    assert.deepEqual(await invoke(CH.testLlmKey, WIZARD, { provider: 'anthropic', apiKey: 'short' }), {
      ok: false,
      error: 'Key looks too short.',
    });
  });

  it('reveals the recovery key to the wizard during setup', async () => {
    view = 'wizard';
    // null: the wizard completes with the current data folder.
    const key = await invoke(CH.exportRecoveryKey, WIZARD, null);
    assert.equal(typeof key, 'string');
    assert.equal(Buffer.from(String(key), 'base64').length, 32);
  });

  it('rejects a malformed capability selection before writing anything', async () => {
    view = 'wizard';
    appOrigin = null;
    // The payload is renderer data. main persists and acts on the switches, so
    // a selection it cannot read is refused rather than stored as-is.
    for (const capabilities of [undefined, null, 'on', { attachments: 'yes' }, { embeddings: true }]) {
      assert.deepEqual(await invoke(CH.complete, WIZARD, { ...SETUP, capabilities }), {
        ok: false,
        error: 'Invalid capability selection.',
      });
    }
    // The secrets file exists by now (the reveal above creates the vault key);
    // what a refused completion must not do is save setup or boot.
    assert.equal(fs.existsSync(setupFile()), false, 'no setup.json');
    assert.equal(calls.boot, 0, 'the stack was not booted');
  });

  it('completes setup, reading the sender before the first await', async () => {
    view = 'wizard';
    appOrigin = null;
    // Electron answers null for `senderFrame` once the frame has navigated
    // away. Model that: the frame is only readable during the synchronous
    // part of the call, so a check made after an await would refuse here.
    let readable = true;
    const sender = { isDestroyed: () => false, send: () => undefined };
    const event = {
      sender,
      get senderFrame(): FakeFrame | null {
        return readable ? WIZARD : null;
      },
    } as unknown as IpcMainInvokeEvent;
    const handler = handlers.get(CH.complete);
    assert.ok(handler);
    const pending = handler(event, SETUP);
    readable = false;
    assert.deepEqual(await pending, { ok: true });
    assert.equal(calls.boot, 1);
    assert.deepEqual(calls.ready, [UI]);
    const setup = JSON.parse(fs.readFileSync(setupFile(), 'utf8')) as {
      completed?: boolean;
      capabilities?: unknown;
    };
    assert.equal(setup.completed, true);
    assert.deepEqual(setup.capabilities, { attachments: true });
  });

  it('persists only the switches the supervisor reads, whatever else the page sends', async () => {
    view = 'wizard';
    appOrigin = null;
    // A page from an older build still sends the removed switches.
    const stale = { ...SETUP, capabilities: { attachments: false, embeddings: true, diagrams: true } };
    assert.deepEqual(await invoke(CH.complete, WIZARD, stale), { ok: true });
    const setup = JSON.parse(fs.readFileSync(setupFile(), 'utf8')) as { capabilities?: unknown };
    assert.deepEqual(setup.capabilities, { attachments: false });
  });

  // Last in the file: completing with a picked folder moves the data dir.
  it('reveals the key of a picked folder with an earlier install, the key setup then keeps', async () => {
    view = 'wizard';
    appOrigin = null;
    const picked = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-ipc-picked-'));
    const pickedFile = path.join(picked, 'secrets.enc');
    const earlier = {
      vaultKey: Buffer.alloc(32, 7).toString('base64'),
      credentialKeychainKey: Buffer.alloc(32, 8).toString('base64'),
      providerKeys: {},
    };
    const bytes = Buffer.from(JSON.stringify(earlier), 'utf8');
    fs.writeFileSync(pickedFile, bytes, { mode: 0o600 });
    const current = await invoke(CH.exportRecoveryKey, WIZARD, null);

    __setOpenDialogHandler(async () => ({ canceled: false, filePaths: [picked] }));
    try {
      assert.equal(await invoke(CH.chooseDataDir, WIZARD), picked);
    } finally {
      __setOpenDialogHandler(null);
    }
    const shown = await invoke(CH.exportRecoveryKey, WIZARD, picked);
    assert.equal(shown, earlier.vaultKey, 'the key of the blob in the picked folder');
    assert.notEqual(shown, current);
    assert.deepEqual(fs.readFileSync(pickedFile), bytes, 'revealing it wrote nothing');

    assert.deepEqual(await invoke(CH.complete, WIZARD, { ...SETUP, dataDir: picked }), { ok: true });
    assert.equal(secretsFile(), pickedFile, 'setup bound the picked folder');
    assert.equal(await invoke(CH.exportRecoveryKey, WIZARD, null), shown, 'the key shown is the key in use');
    assert.deepEqual(fs.readFileSync(pickedFile), bytes, 'the earlier blob is byte-identical');
    assert.deepEqual(
      fs.readdirSync(picked).filter((name) => name.startsWith('secrets.enc')),
      ['secrets.enc'],
      'no backup and no temp file: nothing was rewritten',
    );
  });
});
