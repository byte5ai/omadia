import type { StopOutcome } from './supervisor';

/**
 * Deciding whether an update may be handed to the installer (#926).
 *
 * Split out from the updater so the abort paths can be tested without Electron
 * or a release feed. The dialogs stay in `updater.ts`; only the decision lives
 * here.
 */

export type InstallPreflight =
  | { readonly ok: true }
  /** The stack did not come down, so the app bundle is still in use. */
  | { readonly ok: false; readonly reason: 'unclean'; readonly survivors: readonly string[] }
  /** Quiescing or snapshotting threw. */
  | { readonly ok: false; readonly reason: 'failed'; readonly error: string };

export interface PreflightSteps {
  /** Bring the stack down. `null` when there is no supervisor to stop. */
  stop: (() => Promise<StopOutcome>) | null;
  /** Snapshot the database. Throwing aborts the install. */
  snapshot: (version: string) => void;
}

/**
 * Quiesce, then snapshot, and report whether the installer may proceed.
 *
 * Order matters twice over: the stack must be down before the database
 * directory is copied (a live copy can be torn and unrestorable), and the
 * result must be checked before handing off, because Squirrel cannot replace a
 * bundle whose processes are still running out of it.
 */
export async function prepareInstall(
  steps: PreflightSteps,
  version: string,
): Promise<InstallPreflight> {
  try {
    if (steps.stop !== null) {
      const outcome = await steps.stop();
      if (!outcome.clean) {
        return { ok: false, reason: 'unclean', survivors: outcome.survivors };
      }
    }
    steps.snapshot(version);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}
