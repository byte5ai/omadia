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

import { __setDialogHandler, __lastClipboardText } from './helpers/electron-fake.mjs';
import {
  showBootFailure,
  showRecoveryExhausted,
  showRecoveryKey,
  showRecoveryKeyUnavailable,
  showRecoveryReminder,
  showRestartRefused,
  showSupersededBoot,
} from '../src/shellDialogs.ts';
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

  it('showBootFailure maps the buttons to rerun-setup / quit', async () => {
    nextResponse = 0;
    assert.equal(await showBootFailure(fakeWindow(), t, 'd', '/log'), 'rerun-setup');
    nextResponse = 1;
    assert.equal(await showBootFailure(fakeWindow(), t, 'd', '/log'), 'quit');
  });
});
