import path from 'node:path';
import { fillPlaceholders, type ShellTranslate } from './shellStrings';
import type { SecretsUnreadableStage } from './secretsBlob';

/**
 * What to tell a user whose secrets file exists but cannot be opened.
 *
 * One source for two audiences: the error message (English, for the log, the
 * setup wizard and support) and the boot dialog (in the user's language, via
 * `shellDialogs.ts`). Kept Electron-free so both can use it.
 *
 * The advice is specific to the stage that failed, on purpose. A keychain that
 * refused (or a Linux keyring that is not running) leaves an intact file, and
 * the backup and snapshot copies are encrypted with the same keychain item, so
 * "restore the backup" or "delete the file" would be exactly the wrong first
 * step there. A damaged file is the case the backup is for.
 *
 * Starting over is described as moving the whole data folder aside, never as
 * deleting `secrets.enc`: new keys next to the old kernel vault
 * (`platform-data/vault.enc.json`) leave the kernel unable to open it, so a
 * lone deleted file would trade this failure for a kernel that cannot boot.
 */

const ENGLISH: ShellTranslate = (_key, fallback) => fallback;

/**
 * The copy of the previous file that `secretsBlob.ts` keeps before every
 * rewrite. Defined here because this is the module that has to name it to the
 * user; the writer imports it, so the two can never disagree.
 */
export function secretsBackupFile(file: string): string {
  return `${file}.bak`;
}

export interface SecretsRecoveryContext {
  readonly file: string;
  readonly stage: SecretsUnreadableStage;
  /** Where pre-update snapshots live; null when it could not be resolved. */
  readonly snapshotDir: string | null;
}

/** The next step for this stage, in the user's language (English by default). */
export function secretsRemedy(context: SecretsRecoveryContext, t: ShellTranslate = ENGLISH): string {
  const copies = {
    backup: secretsBackupFile(context.file),
    snapshots: context.snapshotDir ?? t('secrets.snapshotsUnknown', 'the "snapshots" folder'),
  };
  switch (context.stage) {
    case 'read':
      return t(
        'secrets.remedy.read',
        'The file exists but could not be read. Check that your user account may read it and that its drive is connected, then start omadia again.',
      );
    case 'decrypt':
      return fillPlaceholders(
        t(
          'secrets.remedy.decrypt',
          'The operating system keychain did not unlock it. The file itself is most likely intact, so do not delete it: start omadia again and allow keychain access when asked (macOS: "Always Allow"; Linux: unlock your keyring). If that keeps failing, the file may be damaged: quit omadia and replace it with the backup {backup} or with the newest *.secrets.enc copy in {snapshots}.',
        ),
        copies,
      );
    case 'encryption-unavailable':
      return t(
        'secrets.remedy.noKeyring',
        'OS-backed encryption (keychain/credential store) is unavailable, so omadia cannot decrypt it. The file itself is most likely intact, so do not delete it. On Linux, configure a Secret Service keyring (e.g. gnome-keyring/libsecret), then start omadia again.',
      );
    case 'parse':
    case 'shape':
      return fillPlaceholders(
        t(
          'secrets.remedy.damaged',
          'The file is damaged. Quit omadia and replace it with the backup {backup} or with the newest *.secrets.enc copy in {snapshots}, then start omadia again.',
        ),
        copies,
      );
  }
}

/** The last resort, in the user's language (English by default). */
export function secretsStartOver(file: string, t: ShellTranslate = ENGLISH): string {
  return fillPlaceholders(
    t(
      'secrets.startOver',
      'Only if the keys cannot be recovered: quit omadia and move the data folder {dataDir} aside (keep it, do not delete it). omadia then runs first-time setup with new keys; the moved folder still holds your data and the old keys.',
    ),
    { dataDir: path.dirname(file) },
  );
}

/** The English error message: what failed, that nothing was replaced, and what to do. */
export function secretsUnreadableMessage(
  context: SecretsRecoveryContext & { readonly reason: string },
): string {
  return (
    `omadia could not open its secrets file ${context.file} (${context.stage}: ${context.reason}). ` +
    'It was left untouched: new keys would make the local vault, stored credentials and provider keys unrecoverable. ' +
    `${secretsRemedy(context)} ${secretsStartOver(context.file)}`
  );
}
