import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log';

/**
 * Consecutive failed *silent* update checks before omadia says so once (#928).
 *
 * A failed check is not the same state as "you are up to date", but until now
 * both looked identical to anyone who never opens the tray menu: the startup
 * check logs its error and stops there. A dead update channel was therefore
 * indistinguishable from being current — the mechanism behind OM-52 and OM-69.
 *
 * Three is deliberately conservative. `initUpdater()` runs one check per app
 * start, so this counts app starts, not retries within a session: a single
 * network blip, or the brief window right after a release, must not produce a
 * dialog. A channel that stays broken across three starts is not a blip.
 */
export const FAILURE_STREAK_BEFORE_NOTICE = 3;

export interface CheckHealth {
  readonly consecutiveFailures: number;
  /** True once the user has been told about the CURRENT streak. */
  readonly noticeShown: boolean;
}

const HEALTHY: CheckHealth = { consecutiveFailures: 0, noticeShown: false };

/**
 * Kept in Electron's own userData dir rather than under the user-chosen data
 * directory: this is updater bookkeeping, not user data, and it must survive
 * the user moving or resetting their data directory.
 */
function healthFile(): string {
  return path.join(app.getPath('userData'), 'updater-check-health.json');
}

function read(): CheckHealth {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(healthFile(), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return HEALTHY;
    const record = parsed as Record<string, unknown>;
    const failures = record['consecutiveFailures'];
    return {
      consecutiveFailures:
        typeof failures === 'number' && Number.isFinite(failures) && failures > 0
          ? Math.floor(failures)
          : 0,
      noticeShown: record['noticeShown'] === true,
    };
  } catch {
    // A fresh install has no file and a corrupt one is not worth a crash;
    // either way the safe reading is "no failures recorded yet".
    return HEALTHY;
  }
}

function write(next: CheckHealth): void {
  try {
    fs.mkdirSync(path.dirname(healthFile()), { recursive: true });
    fs.writeFileSync(healthFile(), JSON.stringify(next), 'utf8');
  } catch (err) {
    // Bookkeeping must never break the update path it is only observing.
    log.warn(`[updater] could not persist update-check health: ${String(err)}`);
  }
}

/** A check that reached the feed — whether or not it found a new version. */
export function recordCheckReachedFeed(): void {
  const current = read();
  if (current.consecutiveFailures === 0 && !current.noticeShown) return;
  write(HEALTHY);
}

export interface FailureVerdict {
  readonly consecutiveFailures: number;
  /** True exactly once per streak, on the check that crosses the threshold. */
  readonly shouldNotify: boolean;
}

/**
 * The whole decision, as a pure function of the previous state — kept separate
 * from the file IO so the notify-once-per-streak rule is verifiable without an
 * Electron runtime. The desktop test setup arriving with #932 is the intended
 * home for that test.
 *
 * @param alreadySurfaced the failure came from a manual check, so the user is
 *   being shown the error anyway; count it, but never queue a second notice.
 */
export function nextFailureState(
  current: CheckHealth,
  alreadySurfaced: boolean,
): { readonly next: CheckHealth; readonly verdict: FailureVerdict } {
  const consecutiveFailures = current.consecutiveFailures + 1;
  const shouldNotify =
    !alreadySurfaced &&
    !current.noticeShown &&
    consecutiveFailures >= FAILURE_STREAK_BEFORE_NOTICE;
  return {
    next: {
      consecutiveFailures,
      noticeShown: current.noticeShown || shouldNotify || alreadySurfaced,
    },
    verdict: { consecutiveFailures, shouldNotify },
  };
}

export function recordCheckFailed(alreadySurfaced: boolean): FailureVerdict {
  const { next, verdict } = nextFailureState(read(), alreadySurfaced);
  write(next);
  return verdict;
}
