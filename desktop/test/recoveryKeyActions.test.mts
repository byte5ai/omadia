/**
 * The recovery-key reminder must never fail the boot it rides on (OM-58).
 *
 * `maybeRemindRecoveryKey` runs inside `showAppPage`, which both the boot of an
 * existing install and the tray restart await. Whatever rejects in it lands in
 * the boot's `catch`: a healthy, running app then shows the boot-failure
 * dialog, whose only choices are re-running setup over a working install or
 * quitting. Electron 44 made `clipboard.writeText` a promise that can reject,
 * so a failed copy is the case that has to be pinned here.
 */
import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import type { BrowserWindow } from 'electron';

import { __failNextClipboardWrite, __setDialogHandler } from './helpers/electron-fake.mjs';
import { maybeRemindRecoveryKey, showRecoveryKeyAction } from '../src/recoveryKeyActions.ts';
import { readSetup, writeSetup } from '../src/setupState.ts';
import type { ShellTranslate } from '../src/shellStrings.ts';

const t: ShellTranslate = (_key, fallback) => fallback;
const win = { isDestroyed: () => false } as unknown as BrowserWindow;

let titles: string[] = [];

beforeEach(() => {
  titles = [];
  // Button 0 everywhere: "Show now" on the reminder, "Copy" on the key dialog.
  __setDialogHandler((...args: unknown[]) => {
    const options = args[args.length - 1] as { title?: string };
    titles.push(options.title ?? '');
    return Promise.resolve({ response: 0, checkboxChecked: false });
  });
  // A boot-verified install that has never displayed its key.
  writeSetup({ ...readSetup(), completed: true, recoveryKeyShown: false });
});

describe('maybeRemindRecoveryKey', () => {
  it('resolves when the copy fails, and records that the key was shown', async () => {
    __failNextClipboardWrite(new Error('clipboard unavailable'));

    await maybeRemindRecoveryKey(win, t);

    assert.equal(titles.length, 3, `reminder, key, copy-failed note — got ${titles.join(' | ')}`);
    assert.equal(
      readSetup().recoveryKeyShown,
      true,
      'the key was on screen twice; the reminder must not come back',
    );
  });

  it('shows the key and records it when the copy works', async () => {
    await maybeRemindRecoveryKey(win, t);

    assert.equal(titles.length, 2, `reminder, key — got ${titles.join(' | ')}`);
    assert.equal(readSetup().recoveryKeyShown, true);
  });
});

describe('showRecoveryKeyAction (Help → "Show recovery key…")', () => {
  it('shows the key of a completed install and records it', async () => {
    await showRecoveryKeyAction(win, t, () => false);

    assert.deepEqual(titles, ['Recovery key']);
    assert.equal(readSetup().recoveryKeyShown, true);
  });

  it('points to the wizard step while setup is not complete, without showing a key', async () => {
    writeSetup({ ...readSetup(), completed: false, recoveryKeyShown: false });

    await showRecoveryKeyAction(win, t, () => false);

    assert.deepEqual(titles, ['Recovery key after setup']);
    assert.equal(readSetup().recoveryKeyShown, false, 'no key was on screen');
  });

  it('points to the wizard step while a re-run of setup is on screen', async () => {
    // A re-run keeps `completed` set until it finishes; the folder may still change.
    await showRecoveryKeyAction(win, t, () => true);

    assert.deepEqual(titles, ['Recovery key after setup']);
    assert.equal(readSetup().recoveryKeyShown, false);
  });
});
