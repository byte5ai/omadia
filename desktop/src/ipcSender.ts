/**
 * Who may call an IPC channel: the trust boundary between renderer and main.
 *
 * The shell's one window shows the bundled wizard and loading pages (`file:`),
 * the loopback web UI after boot, and whatever a server redirect lands it on.
 * Every handler used to answer whichever document was there, so the recovery-key
 * export handed the vault master key to the web UI, to any same-origin plugin
 * iframe in it (calls through `window.parent.omadia` arrive from the MAIN frame
 * with the web UI's origin), and to a foreign page reached by a redirect.
 *
 * Every channel is now registered for one surface, and each call is decided
 * from facts about the frame that sent it, never from anything the renderer
 * says about itself:
 *
 *  - `wizard` (setup, recovery key, data dir, key test): the sender must be
 *    the main frame, showing the BUNDLED `wizard.html` (compared by file path
 *    against the install), while the navigator shows the wizard view. The
 *    view rule keeps the key out of reach once setup is over; the path rule
 *    covers the moment the navigator has already claimed 'wizard' while the
 *    previous document is still on screen.
 *  - `app` (the web UI's ready/locale pings): the main frame at the running
 *    web UI's exact origin.
 *
 * A sender frame that is gone (null, destroyed, detached, unreadable) is
 * refused, as is any subframe. Pure apart from `node:path`/`node:url`, so the
 * rules are tested with synthetic values (`ipcSender.test.mts`); `ipc.ts` does
 * the Electron glue.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WIZARD_PAGE } from './bridgeSurface';
import type { ShellView } from './shellView';

export type IpcSurface = 'wizard' | 'app';

/** What main knows about the frame that sent a message. */
export interface SenderFacts {
  /** The frame's URL, or null when the frame is gone (null, destroyed, detached, unreadable). */
  readonly frameUrl: string | null;
  readonly frameOrigin: string | null;
  readonly isMainFrame: boolean;
}

/** What main knows about itself when the message arrives. */
export interface SenderContext {
  /** Absolute path of the bundled renderer pages (`<app>/dist/renderer`). */
  readonly rendererDir: string;
  /** Origin of the running web UI; null before the first boot and after a stop. */
  readonly appOrigin: string | null;
  /** What the window navigator says is on screen (`shellNavigator.ts`). */
  readonly view: ShellView;
}

/** Same shape as `NavDecision` in `shellView.ts`: a refusal always says why. */
export interface SenderDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

/** The part of Electron's `WebFrameMain` read here; structural, so tests need no Electron. */
export interface SenderFrameLike {
  readonly url: string;
  readonly origin: string;
  readonly parent: unknown;
  readonly detached?: boolean;
  isDestroyed?(): boolean;
}

/** The part of an `IpcMainEvent` / `IpcMainInvokeEvent` read here. */
export interface SenderEventLike {
  readonly senderFrame?: SenderFrameLike | null;
}

const ALLOWED: SenderDecision = { allowed: true };
const GONE: SenderFacts = { frameUrl: null, frameOrigin: null, isMainFrame: false };

/**
 * Snapshot the sender frame. Call it on entry, synchronously: Electron answers
 * null for `senderFrame` once the frame has navigated away or died, and reading
 * a disposed frame's properties throws. Both fail closed as "gone".
 */
export function readSenderFacts(event: SenderEventLike): SenderFacts {
  try {
    const frame = event.senderFrame;
    if (frame === null || frame === undefined) return GONE;
    if (frame.isDestroyed?.() === true || frame.detached === true) return GONE;
    return { frameUrl: frame.url, frameOrigin: frame.origin, isMainFrame: frame.parent === null };
  } catch {
    return GONE;
  }
}

export function decideSender(
  surface: IpcSurface,
  facts: SenderFacts,
  ctx: SenderContext,
): SenderDecision {
  if (facts.frameUrl === null) return { allowed: false, reason: 'sender frame gone' };
  if (!facts.isMainFrame) return { allowed: false, reason: 'not the main frame' };
  return surface === 'wizard' ? decideWizard(facts.frameUrl, ctx) : decideApp(facts, ctx);
}

function decideWizard(frameUrl: string, ctx: SenderContext): SenderDecision {
  if (!isBundledPage(frameUrl, ctx.rendererDir, WIZARD_PAGE)) {
    // Expected vs actual, so a path mismatch in a packaged build (asar path,
    // drive-letter case) is diagnosable from the log instead of a dead wizard.
    const expected = pathToFileURL(path.join(ctx.rendererDir, WIZARD_PAGE)).href;
    return {
      allowed: false,
      reason: `not the bundled wizard page (got ${withoutQuery(frameUrl)}, expected ${expected})`,
    };
  }
  if (ctx.view !== 'wizard') {
    return { allowed: false, reason: `wizard channel outside first-run setup (view=${ctx.view})` };
  }
  return ALLOWED;
}

function decideApp(facts: SenderFacts, ctx: SenderContext): SenderDecision {
  if (ctx.appOrigin === null) return { allowed: false, reason: 'no web UI is serving' };
  if (facts.frameOrigin !== ctx.appOrigin) {
    return {
      allowed: false,
      reason: `origin ${String(facts.frameOrigin)} is not the web UI (${ctx.appOrigin})`,
    };
  }
  return ALLOWED;
}

/**
 * Whether `url` is the bundled `page` in `rendererDir`, compared as file paths.
 *
 * Query and hash are irrelevant (`fileURLToPath` drops them); dot segments are
 * resolved by URL parsing, so `renderer/../../wizard.html` is a different file.
 * A file URL with a host or an encoded slash makes `fileURLToPath` throw and
 * is refused.
 */
export function isBundledPage(url: string, rendererDir: string, page: string): boolean {
  let file: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return false;
    file = fileURLToPath(parsed);
  } catch {
    return false;
  }
  return samePath(path.resolve(file), path.resolve(rendererDir, page));
}

/** Windows paths are case-insensitive (drive letter, install dir); elsewhere they are not. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** A URL for the log: its query or hash may carry a credential. */
function withoutQuery(url: string): string {
  try {
    const copy = new URL(url);
    copy.search = '';
    copy.hash = '';
    return copy.href;
  } catch {
    return 'an unparsable URL';
  }
}
