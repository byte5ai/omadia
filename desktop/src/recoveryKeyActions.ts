/**
 * The vault recovery key's second path (OM-58).
 *
 * The wizard offered the key exactly once, on a step that a boot finishing
 * mid-setup could overwrite without anyone noticing — so a tester reached a
 * working app having never been shown the key that decrypts his vault. On a
 * product running a local database that is a silent data-loss risk.
 *
 * Two affordances live here: showing the key on demand (Help → "Show recovery
 * key…", always available), and a one-time reminder for a boot-verified install
 * that has never displayed it.
 *
 * KNOWN GAP, and it is not fixable from this side: viewing the key through this
 * path is the only moment the shell can observe. The wizard's own *Reveal*
 * button goes through the `exportRecoveryKey` IPC handler in `ipc.ts`, which
 * cannot mark the flag today. A user who did read the key off the wizard's last
 * step therefore sees one extra prompt. That trade is deliberate: one redundant
 * dialog is cheaper than an unrecoverable vault, and the reminder only ever
 * costs a launch of earliness — `needsRecoveryKeyReminder()` gates on
 * `completed && !recoveryKeyShown`, so a user who genuinely SKIPPED the step is
 * still caught on the next start. The proper fix is one line in that IPC
 * handler, and it is commented there so whoever works in `ipc.ts` finds it.
 */
import type { BrowserWindow } from 'electron';
import { exportRecoveryKey } from './secrets';
import { log, logFile } from './log';
import { describeError } from './bootFailure';
import { markRecoveryKeyShown, needsRecoveryKeyReminder } from './setupState';
import {
  showRecoveryKey,
  showRecoveryKeyUnavailable,
  showRecoveryReminder,
} from './shellDialogs';
import type { ShellTranslate } from './shellStrings';

export async function showRecoveryKeyAction(win: BrowserWindow, t: ShellTranslate): Promise<void> {
  let key: string;
  try {
    key = exportRecoveryKey();
  } catch (err) {
    log.error(`[main] recovery key unavailable: ${describeError(err)}`);
    await showRecoveryKeyUnavailable(win, t, describeError(err), logFile());
    return;
  }

  await showRecoveryKey(win, t, key);

  // Recorded AFTER the dialog closes, and guarded: `writeSetup` is a bare
  // `writeFileSync`, so a read-only directory or a full disk would otherwise
  // reject this function — which the fire-and-forget call sites `void` — leaving
  // an unhandled rejection while the user may never have seen the key. Recording
  // before the dialog would additionally suppress the reminder for a user who
  // never got to read it.
  try {
    markRecoveryKeyShown();
  } catch (err) {
    log.error(`[main] could not record that the recovery key was shown: ${describeError(err)}`);
  }
}

/**
 * Ask once, for a boot-verified install that has never displayed the key.
 *
 * Callers await the UI-ready gate first (OM-71): the reminder used to appear
 * over "Loading login…" because `loadURL` resolves on the document, not on the
 * screen the user is going to see.
 */
export async function maybeRemindRecoveryKey(win: BrowserWindow, t: ShellTranslate): Promise<void> {
  if (!needsRecoveryKeyReminder()) return;
  if ((await showRecoveryReminder(win, t)) === 'show-now') await showRecoveryKeyAction(win, t);
}
