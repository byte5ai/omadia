/**
 * Every native dialog is attached to the main window (OM-71 / #1005).
 *
 * Five of the seven dialogs in `shellDialogs.ts` were shown without a parent.
 * On macOS an unparented `showMessageBox` is application-modal and free
 * floating, so the reminder about the recovery key could be half covered by a
 * system dialog. The one dialog that shows the key decrypting the local vault
 * must not be the one that can get lost behind other windows.
 *
 * The electron fake forwards the exact `showMessageBox` arguments, so the
 * assertion is on what the production code passes, not on a reimplementation.
 */
import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import type { BrowserWindow } from 'electron';

import {
  __setDialogHandler,
  __lastClipboardText,
  __failNextClipboardWrite,
} from './helpers/electron-fake.mjs';
import {
  showBootFailure,
  showRecoveryExhausted,
  showRecoveryKey,
  showRecoveryKeyUnavailable,
  showRecoveryReminder,
  showRestartRefused,
  showSecretsUnreadable,
  showSupersededBoot,
} from '../src/shellDialogs.ts';
import { onLog, type LogLevel } from '../src/log.ts';
import type { ShellTranslate } from '../src/shellStrings.ts';
import type { SecretsFailure } from '../src/bootFailure.ts';

const t: ShellTranslate = (_key, fallback) => fallback;

interface RecordedCall {
  readonly args: unknown[];
}

function fakeWindow(destroyed = false): BrowserWindow {
  return { isDestroyed: () => destroyed } as unknown as BrowserWindow;
}

let calls: RecordedCall[] = [];
let nextResponse = 0;
/** Answers for successive dialogs; `nextResponse` once it runs dry. */
let queuedResponses: number[] = [];

beforeEach(() => {
  calls = [];
  nextResponse = 0;
  queuedResponses = [];
  __setDialogHandler((...args: unknown[]) => {
    calls.push({ args });
    const response = queuedResponses.shift() ?? nextResponse;
    return Promise.resolve({ response, checkboxChecked: false });
  });
});

const SECRETS_FAILURE: SecretsFailure = {
  file: '/data/secrets.enc',
  stage: 'decrypt',
  reason: 'keychain denied',
  snapshotDir: '/data/snapshots',
};

function optionsOf(call: RecordedCall | undefined): { buttons: string[]; detail: string } {
  assert.ok(call, 'expected a dialog');
  return call.args[call.args.length - 1] as { buttons: string[]; detail: string };
}

/** Every dialog, called the way production calls it. */
const dialogs: ReadonlyArray<readonly [string, (win: BrowserWindow) => Promise<unknown>]> = [
  ['showSupersededBoot', (win) => showSupersededBoot(win, t)],
  ['showBootFailure', (win) => showBootFailure(win, t, 'detail', '/log')],
  ['showRecoveryExhausted', (win) => showRecoveryExhausted(win, t, '/log')],
  ['showRestartRefused', (win) => showRestartRefused(win, t)],
  ['showRecoveryKey', (win) => showRecoveryKey(win, t, 'KEY-1234')],
  ['showRecoveryKeyUnavailable', (win) => showRecoveryKeyUnavailable(win, t, 'boom', '/log')],
  ['showRecoveryReminder', (win) => showRecoveryReminder(win, t)],
  [
    'showSecretsUnreadable',
    (win) => showSecretsUnreadable(win, t, SECRETS_FAILURE, '/log', () => {}),
  ],
];

describe('shellDialogs parent window (OM-71)', () => {
  for (const [name, show] of dialogs) {
    it(`${name} passes the main window as the dialog parent`, async () => {
      const win = fakeWindow();
      nextResponse = 1;
      await show(win);
      assert.equal(calls.length, 1, `${name} should show exactly one dialog`);
      const [parent, options] = calls[0]!.args;
      assert.equal(parent, win, `${name} must attach the dialog to the window`);
      assert.equal(typeof options, 'object');
      assert.ok((options as { title?: unknown }).title, `${name} options carry a title`);
    });
  }

  it('falls back to an unparented dialog when the window is already destroyed', async () => {
    // A dialog that would otherwise throw on a destroyed parent is worse than
    // a free-floating one; the vault key must still be shown.
    nextResponse = 1;
    await showRecoveryReminder(fakeWindow(true), t);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.args.length, 1, 'no parent argument for a destroyed window');
    assert.equal(typeof calls[0]!.args[0], 'object');
  });
});

describe('shellDialogs choices', () => {
  it('showRecoveryReminder maps button 0 to show-now and 1 to later', async () => {
    nextResponse = 0;
    assert.equal(await showRecoveryReminder(fakeWindow(), t), 'show-now');
    nextResponse = 1;
    assert.equal(await showRecoveryReminder(fakeWindow(), t), 'later');
  });

  it('showRecoveryKey copies the key when the copy button is chosen', async () => {
    nextResponse = 0;
    await showRecoveryKey(fakeWindow(), t, 'KEY-COPY-ME');
    assert.equal(__lastClipboardText(), 'KEY-COPY-ME');
  });

  // Electron 44 turned clipboard.writeText into a promise that can reject (a
  // Linux session without a clipboard, for one). The key dialog runs inside the
  // boot sequence, where a rejection reads as a failed boot, so a failed copy
  // must resolve — and the user, who believes the key is on the clipboard, has
  // to be told it is not and shown the key again.
  it('showRecoveryKey survives a failed copy and shows the key again', async () => {
    nextResponse = 0;
    __failNextClipboardWrite(new Error('clipboard unavailable'));
    const logged: Array<{ level: LogLevel; msg: string }> = [];
    const unsubscribe = onLog((level, msg) => logged.push({ level, msg }));
    try {
      await showRecoveryKey(fakeWindow(), t, 'KEY-X');
    } finally {
      unsubscribe();
    }

    assert.equal(calls.length, 2, 'the key dialog, then the copy-failed note');
    const note = calls[1]!.args[1] as { title?: string; detail?: string };
    assert.match(note.title ?? '', /copy/i);
    assert.match(note.detail ?? '', /KEY-X/, 'the note repeats the key so it can be written down');
    assert.notEqual(__lastClipboardText(), 'KEY-X', 'the key never reached the clipboard');

    const errors = logged.filter((line) => line.level === 'ERROR');
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.msg, /clipboard unavailable/);
    assert.doesNotMatch(errors[0]!.msg, /KEY-X/, 'the log is attached to bug reports; the key stays out');
  });

  it('showBootFailure maps the buttons to rerun-setup / quit', async () => {
    nextResponse = 0;
    assert.equal(await showBootFailure(fakeWindow(), t, 'd', '/log'), 'rerun-setup');
    nextResponse = 1;
    assert.equal(await showBootFailure(fakeWindow(), t, 'd', '/log'), 'quit');
  });
});

describe('showSecretsUnreadable', () => {
  it('offers no way to re-run setup or to start over, only the file and Quit', async () => {
    nextResponse = 1;
    const shown: string[] = [];
    await showSecretsUnreadable(fakeWindow(), t, SECRETS_FAILURE, '/log', (file) => shown.push(file));
    const { buttons } = optionsOf(calls[0]);
    assert.equal(buttons.length, 2);
    for (const label of buttons) {
      assert.doesNotMatch(label, /setup|start over|delete|reset/i, `unexpected button "${label}"`);
    }
    assert.deepEqual(shown, [], 'Quit opens nothing');
  });

  it('shows the file on the first button and comes back until the user quits', async () => {
    queuedResponses = [0, 0, 1];
    const shown: string[] = [];
    await showSecretsUnreadable(fakeWindow(), t, SECRETS_FAILURE, '/log', (file) => shown.push(file));
    assert.deepEqual(shown, ['/data/secrets.enc', '/data/secrets.enc']);
    assert.equal(calls.length, 3, 'the instructions stay available while the user restores');
  });

  it('leads with the keychain for a decrypt failure and rules out deleting the file', async () => {
    nextResponse = 1;
    await showSecretsUnreadable(fakeWindow(), t, SECRETS_FAILURE, '/log', () => {});
    const { detail } = optionsOf(calls[0]);
    assert.match(detail, /do not delete/i);
    assert.ok(
      detail.indexOf('keychain access') < detail.indexOf('/data/secrets.enc.bak'),
      'keychain advice before the restore hint',
    );
    assert.match(detail, /decrypt: keychain denied/, 'the stage and reason reach the support section');
    assert.match(detail, /\/log/);
  });

  it('points a damaged file at its backup and the resolved snapshot folder', async () => {
    nextResponse = 1;
    await showSecretsUnreadable(
      fakeWindow(),
      t,
      { ...SECRETS_FAILURE, stage: 'parse', reason: 'not valid JSON at position 57' },
      '/log',
      () => {},
    );
    const { detail } = optionsOf(calls[0]);
    assert.ok(detail.includes('/data/secrets.enc.bak'), detail);
    assert.ok(detail.includes('/data/snapshots'), detail);
    // Starting over is described as a manual step on the whole data folder:
    // new keys next to the old vault would leave the kernel unable to boot.
    assert.match(detail, /move the data folder \/data aside/);
  });
});
