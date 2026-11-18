import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from './log';

/**
 * What to tell the user when electron-updater reports `update-not-available`.
 *
 * That event means two different things. Either the feed's version is the one
 * we run, or the feed declares a `minimumSystemVersion` this computer is below:
 * electron-updater (6.8.9, `AppUpdater.checkIfUpdateSupported`) then withholds
 * the update and emits the same event with the FEED's UpdateInfo. The macOS
 * feed carries such a floor (`scripts/merge-mac-update-feed.mjs`: `22.0.0`, the
 * Darwin kernel of macOS 13, which Electron 44 needs). Reading the event as "up
 * to date" told a macOS 11 or 12 install it was current, named the release it
 * cannot install as its own version, and left it on a runtime that no longer
 * gets security fixes without a word.
 *
 * So the decision here separates the two, and says the second one once on its
 * own: a user who never opens "Check for Updates…" would otherwise never learn
 * that updates have stopped.
 */

/** The fields of electron-updater's UpdateInfo this decision reads. */
export interface FeedInfo {
  readonly version: string;
  readonly minimumSystemVersion?: string | undefined;
}

/** An update the feed offers that this computer's OS is too old to run. */
export interface HoldBack {
  /** The release this computer is not offered. */
  readonly version: string;
  /** The feed's floor, in the `os.release()` form electron-updater compares. */
  readonly minimumSystemVersion: string;
  /** The macOS major the floor stands for ("13"), or null when not known. */
  readonly macos: string | null;
}

// The macOS major for each Darwin kernel major that `os.release()` reports: the
// inverse of DARWIN_BY_MACOS in scripts/merge-mac-update-feed.mjs. macOS 11–15
// are Darwin 20–24; Apple then renumbered macOS 15 → 26 (Darwin 25).
const MACOS_BY_DARWIN: ReadonlyMap<number, string> = new Map([
  [20, '11'],
  [21, '12'],
  [22, '13'],
  [23, '14'],
  [24, '15'],
  [25, '26'],
]);

// semver's strict (non-loose) grammar, which is how electron-updater parses both
// sides of both comparisons below, and semver's length cap, which also bounds
// the regex work on a version string that came from the network.
const MAX_LENGTH = 256;
const NUMERIC = '0|[1-9]\\d*';
const IDENT = `(?:${NUMERIC}|\\d*[a-zA-Z-][a-zA-Z0-9-]*)`;
const SEMVER = new RegExp(
  `^v?(${NUMERIC})\\.(${NUMERIC})\\.(${NUMERIC})` +
    `(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

interface Parsed {
  readonly main: readonly [number, number, number];
  readonly pre: readonly string[];
}

function parse(version: string): Parsed | null {
  if (version.length > MAX_LENGTH) return null;
  const m = SEMVER.exec(version.trim());
  if (!m) return null;
  const main = [Number(m[1]), Number(m[2]), Number(m[3])] as const;
  if (!main.every(Number.isSafeInteger)) return null;
  return { main, pre: m[4] === undefined ? [] : m[4].split('.') };
}

function compareIdentifiers(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Math.sign(Number(a) - Number(b));
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * semver precedence of two versions, or null when either does not parse —
 * where electron-updater's own comparison throws, logs, and lets the update
 * through as supported.
 */
export function compareVersions(a: string, b: string): number | null {
  const x = parse(a);
  const y = parse(b);
  if (x === null || y === null) return null;
  const [xMajor, xMinor, xPatch] = x.main;
  const [yMajor, yMinor, yPatch] = y.main;
  const main =
    Math.sign(xMajor - yMajor) || Math.sign(xMinor - yMinor) || Math.sign(xPatch - yPatch);
  if (main !== 0) return main;
  // A release outranks its own prereleases.
  if (x.pre.length === 0 || y.pre.length === 0) {
    return Math.sign(y.pre.length - x.pre.length);
  }
  const length = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < length; i += 1) {
    const p: string | undefined = x.pre[i];
    const q: string | undefined = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const d = compareIdentifiers(p, q);
    if (d !== 0) return d;
  }
  return 0;
}

/** "22.0.0" → "13". Only whole-major floors name a macOS release. */
function macosFor(floor: string): string | null {
  const parsed = parse(floor);
  if (parsed === null || parsed.pre.length > 0) return null;
  const [darwin, minor, patch] = parsed.main;
  if (minor !== 0 || patch !== 0) return null;
  return MACOS_BY_DARWIN.get(darwin) ?? null;
}

/**
 * The update the feed withholds from this computer, or null when there is none.
 *
 * Mirrors electron-updater's order: a feed version equal to ours is "current"
 * before the floor is consulted, and only a newer one is an update this
 * computer misses.
 */
export function holdBackOf(
  info: FeedInfo,
  currentVersion: string,
  osRelease: string,
  platform: NodeJS.Platform,
): HoldBack | null {
  const floor = info.minimumSystemVersion;
  if (!floor) return null;
  const newer = compareVersions(info.version, currentVersion);
  if (newer === null || newer <= 0) return null;
  const againstFloor = compareVersions(osRelease, floor);
  if (againstFloor === null || againstFloor >= 0) return null;
  return {
    version: info.version,
    minimumSystemVersion: floor,
    macos: platform === 'darwin' ? macosFor(floor) : null,
  };
}

/** Which floor the user has already been told about. */
export interface HoldBackNotice {
  readonly noticedFloor: string | null;
}

export type NoUpdateOutcome =
  | { readonly kind: 'silent' }
  | { readonly kind: 'upToDate'; readonly current: string }
  | { readonly kind: 'heldBack'; readonly current: string; readonly holdBack: HoldBack };

export interface NoUpdateInput {
  readonly info: FeedInfo;
  /** `app.getVersion()` — the version this computer runs, never the feed's. */
  readonly currentVersion: string;
  readonly osRelease: string;
  readonly platform: NodeJS.Platform;
  /** The user asked ("Check for Updates…") and is waiting for an answer. */
  readonly manual: boolean;
  readonly notice: HoldBackNotice;
}

/**
 * The whole decision as a pure function of its inputs, so it is testable
 * without an Electron runtime.
 *
 * A manual check always gets an answer. The silent startup check says nothing
 * when the app is current, and names a hold-back once per floor: every later
 * release behind the same floor is the same news, and repeating it on every
 * start would turn a notice into a nag.
 */
export function noUpdateOutcome(input: NoUpdateInput): {
  readonly outcome: NoUpdateOutcome;
  readonly notice: HoldBackNotice;
  readonly holdBack: HoldBack | null;
} {
  const current = input.currentVersion;
  const holdBack = holdBackOf(input.info, current, input.osRelease, input.platform);
  if (holdBack === null) {
    return {
      outcome: input.manual ? { kind: 'upToDate', current } : { kind: 'silent' },
      notice: input.notice,
      holdBack,
    };
  }
  const show = input.manual || input.notice.noticedFloor !== holdBack.minimumSystemVersion;
  return {
    outcome: show ? { kind: 'heldBack', current, holdBack } : { kind: 'silent' },
    notice: { noticedFloor: holdBack.minimumSystemVersion },
    holdBack,
  };
}

/**
 * Kept in Electron's userData dir beside `updater-check-health.json`: updater
 * bookkeeping, not user data, and it must survive a moved data directory.
 */
function noticeFile(): string {
  return path.join(app.getPath('userData'), 'updater-hold-back.json');
}

function readNotice(): HoldBackNotice {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(noticeFile(), 'utf8'));
    const floor =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)['noticedFloor']
        : undefined;
    return { noticedFloor: typeof floor === 'string' ? floor : null };
  } catch {
    // No file yet, or an unreadable one: nothing has been said.
    return { noticedFloor: null };
  }
}

function writeNotice(next: HoldBackNotice): void {
  try {
    fs.mkdirSync(path.dirname(noticeFile()), { recursive: true });
    fs.writeFileSync(noticeFile(), JSON.stringify(next), 'utf8');
  } catch (err) {
    // Bookkeeping must never break the update path it only observes.
    log.warn(`[updater] could not persist the update hold-back notice: ${String(err)}`);
  }
}

/** {@link noUpdateOutcome} for this computer, remembering what it said. */
export function decideNoUpdate(info: FeedInfo, manual: boolean): NoUpdateOutcome {
  const previous = readNotice();
  const currentVersion = app.getVersion();
  const osRelease = os.release();
  const { outcome, notice, holdBack } = noUpdateOutcome({
    info,
    currentVersion,
    osRelease,
    platform: process.platform,
    manual,
    notice: previous,
  });
  log.info(
    holdBack === null
      ? `[updater] up to date: running ${currentVersion}, feed has ${info.version}`
      : `[updater] ${holdBack.version} needs OS ${holdBack.minimumSystemVersion} or later ` +
          `and this is ${osRelease}; staying on ${currentVersion}`,
  );
  if (notice.noticedFloor !== previous.noticedFloor) writeNotice(notice);
  return outcome;
}
