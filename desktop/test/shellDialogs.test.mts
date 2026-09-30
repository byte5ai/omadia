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
  showSupersededBoot,
} from '../src/shellDialogs.ts';
import { onLog, type LogLevel } from '../src/log.ts';
import type { ShellTranslate } from '../src/shellStrings.ts';

const t: ShellTranslate = (_key, fallback) => fallback;

interface RecordedCall {
  readonly args: unknown[];
}

function fakeWindow(destroyed = false): BrowserWindow {
  return { isDestroyed: () => destroyed } as unknown as BrowserWindow;
}

let calls: RecordedCall[] = [];
let nextResponse = 0;

beforeEach(() => {
  calls = [];
  nextResponse = 0;
  __setDialogHandler((...args: unknown[]) => {
    calls.push({ args });
    return Promise.resolve({ response: nextResponse, checkboxChecked: false });
  });
});

/** Every dialog, called the way production calls it. */
const dialogs: ReadonlyArray<readonly [string, (win: BrowserWindow) => Promise<unknown>]> = [
  ['showSupersededBoot', (win) => showSupersededBoot(win, t)],
  ['showBootFailure', (win) => showBootFailure(win, t, 'detail', '/log')],
  ['showRecoveryExhausted', (win) => showRecoveryExhausted(win, t, '/log')],
  ['showRestartRefused', (win) => showRestartRefused(win, t)],
  ['showRecoveryKey', (win) => showRecoveryKey(win, t, 'KEY-1234')],
  ['showRecoveryKeyUnavailable', (win) => showRecoveryKeyUnavailable(win, t, 'boom', '/log')],
  ['showRecoveryReminder', (win) => showRecoveryReminder(win, t)],
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
