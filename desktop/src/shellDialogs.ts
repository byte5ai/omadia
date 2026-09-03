/**
 * Every native dialog the shell shows (OM-56, OM-57, OM-58, OM-59).
 *
 * Split out of `main.ts` for two reasons. It pushed that file past the 500-line
 * workspace guidance, and more usefully: a dialog is where this product has
 * repeatedly told users something untrue — a deliberate internal state
 * presented as a failure, two buttons that could both do damage, a German
 * string promising an automatic reload the code refuses to perform. Collecting
 * them in one file makes the copy reviewable as a set instead of scattered
 * across an orchestration file.
 *
 * Every function takes the translator rather than building one, so the locale is
 * resolved once at startup and no dialog can silently fall back to English.
 */
import { BrowserWindow, clipboard, dialog, type MessageBoxOptions, type MessageBoxReturnValue } from 'electron';
import { fillPlaceholders, type ShellTranslate } from './shellStrings';

/**
 * Every dialog goes through here so it is attached to the main window (OM-71).
 *
 * Five of the seven used to call `dialog.showMessageBox(options)` without a
 * parent. On macOS that is an application-modal, free-floating window: the
 * reminder about the recovery key was half covered by a system dialog and the
 * dialog that shows the key itself could get lost behind other windows. A
 * destroyed window cannot parent anything, so that one case falls back to the
 * old behaviour rather than throwing over the vault key.
 */
async function messageBox(
  win: BrowserWindow,
  options: MessageBoxOptions,
): Promise<MessageBoxReturnValue> {
  return win.isDestroyed() ? dialog.showMessageBox(options) : dialog.showMessageBox(win, options);
}

/** What the user chose in the boot-failure dialog. */
export type BootFailureChoice = 'rerun-setup' | 'quit';

/** What the user chose when reminded about the recovery key. */
export type RecoveryReminderChoice = 'show-now' | 'later';

/**
 * A boot that was deliberately discarded (OM-56).
 *
 * Deliberately informational with a single button. The old dialog offered
 * *Quit* — which aborts an update mid-flight — and *Re-run setup*, which starts
 * a setup while the database is being snapshotted. Both were destructive, and
 * the only correct action, waiting, was not on offer.
 */
export async function showSupersededBoot(win: BrowserWindow, t: ShellTranslate): Promise<void> {
  await messageBox(win, {
    type: 'info',
    title: t('boot.superseded.title', 'Applying update'),
    message: t('boot.superseded.message', 'omadia is applying an update.'),
    detail: t(
      'boot.superseded.detail',
      'Please wait until it finishes. The window will refresh by itself.',
    ),
    buttons: [t('boot.superseded.ok', 'OK')],
    defaultId: 0,
    cancelId: 0,
  });
}

/** A genuine boot failure: the raw text goes to a labelled support section. */
export async function showBootFailure(
  win: BrowserWindow,
  t: ShellTranslate,
  detail: string,
  logPath: string,
): Promise<BootFailureChoice> {
  const { response } = await messageBox(win, {
    type: 'error',
    title: t('boot.failed.title', 'omadia failed to start'),
    message: t('boot.failed.message', 'omadia could not start its local services.'),
    detail: fillPlaceholders(
      t(
        'boot.failed.detail',
        'You can re-run setup or quit.\n\nTechnical details for support:\n{error}\n\nLog file: {logFile}',
      ),
      { error: detail, logFile: logPath },
    ),
    buttons: [t('boot.failed.rerunSetup', 'Re-run setup'), t('boot.failed.quit', 'Quit')],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0 ? 'rerun-setup' : 'quit';
}

/**
 * The recovery budget is spent (OM-57).
 *
 * Terminal on purpose. Reloading a page that has failed three times is how the
 * first version of the recovery path turned into a silent infinite loop.
 */
export async function showRecoveryExhausted(
  win: BrowserWindow,
  t: ShellTranslate,
  logPath: string,
): Promise<void> {
  await messageBox(win, {
    type: 'error',
    title: t('shell.loadFailed.exhausted.title', 'The interface could not be loaded'),
    message: t(
      'shell.loadFailed.exhausted.message',
      'omadia could not load the interface after several attempts.',
    ),
    detail: fillPlaceholders(
      t(
        'shell.loadFailed.exhausted.detail',
        'No further attempts will be made, to avoid an endless loop.\n\nRestart omadia. If the problem persists, please send the log file to support:\n{logFile}',
      ),
      { logFile: logPath },
    ),
    buttons: [t('shell.loadFailed.exhausted.ok', 'OK')],
    defaultId: 0,
    cancelId: 0,
  });
}

/**
 * A restart was refused because first-run setup is open (OM-58 follow-up).
 *
 * The arbiter already refuses it; without this the tray item just did nothing
 * visible, which is its own small version of the same problem.
 */
export async function showRestartRefused(win: BrowserWindow, t: ShellTranslate): Promise<void> {
  await messageBox(win, {
    type: 'info',
    title: t('shell.restartRefused.title', 'Cannot restart right now'),
    message: t('shell.restartRefused.message', 'First-run setup is still open.'),
    detail: t(
      'shell.restartRefused.detail',
      'omadia will not restart its local services while first-run setup is open, because that would discard your input. Finish setup and try again afterwards.',
    ),
    buttons: [t('shell.restartRefused.ok', 'OK')],
    defaultId: 0,
    cancelId: 0,
  });
}

/** Show the vault recovery key, offering a clipboard copy. */
export async function showRecoveryKey(
  win: BrowserWindow,
  t: ShellTranslate,
  key: string,
): Promise<void> {
  const copyLabel = t('recovery.copy', 'Copy to clipboard');
  const { response } = await messageBox(win, {
    type: 'info',
    title: t('recovery.title', 'Recovery key'),
    message: t('recovery.message', 'Keep this key somewhere safe.'),
    detail: fillPlaceholders(
      t(
        'recovery.detail',
        'This key encrypts your secrets vault. You need it if you ever move omadia to another machine. Losing it makes stored secrets unrecoverable.\n\n{key}',
      ),
      { key },
    ),
    buttons: [copyLabel, t('recovery.close', 'Close')],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) clipboard.writeText(key);
}

export async function showRecoveryKeyUnavailable(
  win: BrowserWindow,
  t: ShellTranslate,
  error: string,
  logPath: string,
): Promise<void> {
  const title = t('recovery.unavailableTitle', 'Recovery key unavailable');
  await messageBox(win, {
    type: 'error',
    title,
    message: title,
    detail: fillPlaceholders(
      t(
        'recovery.unavailableDetail',
        'The key could not be read: {error}\n\nLog file: {logFile}',
      ),
      { error, logFile: logPath },
    ),
  });
}

export async function showRecoveryReminder(
  win: BrowserWindow,
  t: ShellTranslate,
): Promise<RecoveryReminderChoice> {
  const menuItem = t('recovery.menuItem', 'Show recovery key…');
  const { response } = await messageBox(win, {
    type: 'warning',
    title: t('recovery.reminder.title', 'Recovery key not saved yet'),
    message: t('recovery.reminder.message', 'You have not viewed your recovery key yet.'),
    detail: fillPlaceholders(
      t(
        'recovery.reminder.detail',
        'omadia runs a local database. Without this key, stored secrets cannot be recovered after a machine change.\n\nYou can find it any time under "Help" → "{menuItem}".',
      ),
      { menuItem },
    ),
    buttons: [
      t('recovery.reminder.show', 'Show now'),
      t('recovery.reminder.later', 'Later'),
    ],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0 ? 'show-now' : 'later';
}
