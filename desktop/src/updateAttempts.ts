import fs from 'node:fs';
import path from 'node:path';

/**
 * Remembering that we already handed a version to the installer (#926).
 *
 * `initUpdater()` runs one check per app launch, so a failing install is not a
 * loop inside one process - it is the same first-time-looking prompt on every
 * restart. Without a marker on disk the app cannot tell "a new version is
 * available" from "I have already tried to install this exact version twice
 * and I am still not running it". The tester saw the same prompt three times
 * in nine minutes and the app never once said anything was wrong.
 */

export interface UpdateAttemptRecord {
  readonly version: string;
  readonly attempts: number;
  readonly lastAttemptAt: string;
}

/**
 * Attempts for one version before we stop prompting and explain instead. Two,
 * not one: a single failure can be a genuine transient (a locked file, a
 * sleeping machine), while a second one in a row is the bundle swap being
 * structurally blocked.
 */
export const MAX_INSTALL_ATTEMPTS = 2;

function isRecord(value: unknown): value is UpdateAttemptRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<UpdateAttemptRecord>;
  return (
    typeof candidate.version === 'string' &&
    candidate.version.length > 0 &&
    typeof candidate.attempts === 'number' &&
    Number.isInteger(candidate.attempts) &&
    candidate.attempts >= 0 &&
    // Validated rather than coerced: `lastAttemptAt` is typed `string`, so
    // letting a number through here would hand callers a typed lie.
    (candidate.lastAttemptAt === undefined || typeof candidate.lastAttemptAt === 'string')
  );
}

export function readUpdateAttempts(file: string): UpdateAttemptRecord | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isRecord(parsed)) return null;
    return {
      version: parsed.version,
      attempts: parsed.attempts,
      lastAttemptAt: parsed.lastAttemptAt ?? '',
    };
  } catch {
    // Absent or unreadable is the normal case (no update ever attempted), and a
    // corrupt marker must never block an install - fall back to "no history".
    return null;
  }
}

export function writeUpdateAttempts(file: string, record: UpdateAttemptRecord): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } catch (err) {
    // A marker we could not persist degrades to the old behaviour (prompt
    // again) rather than blocking the update the user asked for.
    throw new Error(`could not record update attempt: ${String(err)}`);
  }
}

export function clearUpdateAttempts(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* best effort: a stale marker only costs one extra explanatory dialog */
  }
}

/** The record to persist before handing `version` to the installer. */
export function nextAttempt(
  previous: UpdateAttemptRecord | null,
  version: string,
  now: Date,
): UpdateAttemptRecord {
  const carried = previous !== null && previous.version === version ? previous.attempts : 0;
  return { version, attempts: carried + 1, lastAttemptAt: now.toISOString() };
}

/**
 * True when we have already spent every attempt on this exact version and are
 * still not running it - i.e. the install is silently not taking effect.
 */
export function installKeepsFailing(
  record: UpdateAttemptRecord | null,
  offeredVersion: string,
  runningVersion: string,
  max: number = MAX_INSTALL_ATTEMPTS,
): boolean {
  if (record === null) return false;
  if (record.version !== offeredVersion) return false;
  if (runningVersion === offeredVersion) return false;
  return record.attempts >= max;
}
