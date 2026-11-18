// Retry + expiry sweep over conductor_ephemeral_attachments (#330 C2a).
//
// An ephemeral run (a discussion) binds a conversation for its lifetime. The
// row only disappears after its binding was disposed of, so this sweep
// retries what a reap-time cleanup missed: expired 'pending' rows are claims
// that never became a run, expired 'attached' rows are cleanups the reap did
// not finish. One shared disposal, owned by the caller.
//
// This is what remains of the plugin-era agent setup services
// ('agentProvisioning', 'conversationBindings'): native facilitators (#2043)
// are created by the operator and bound by their own channel identity, so no
// plugin provisions agents or binds conversations any more.

import type {
  ConductorEphemeralAttachmentsStore,
  EphemeralAttachment,
} from '../conductor/ephemeralAttachmentsStore.js';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export function startEphemeralAttachmentSweep(deps: {
  attachments: Pick<ConductorEphemeralAttachmentsStore, 'listExpiredPending' | 'listExpiredAttached'>;
  /** The ONE cleanup path (shared with the reap hook): remove the binding,
   *  delete the row — and only delete the row on success. */
  disposeAttachment: (attachment: EphemeralAttachment, actor: string) => Promise<void>;
  intervalMs?: number;
  now?: () => Date;
  log?: (msg: string) => void;
}): { tick: () => Promise<void>; stop: () => void } {
  const log = deps.log ?? (() => undefined);
  const tick = async (): Promise<void> => {
    try {
      const now = (deps.now ?? (() => new Date()))();
      const expired = [
        ...(await deps.attachments.listExpiredPending(now)),
        ...(await deps.attachments.listExpiredAttached(now)),
      ];
      for (const attachment of expired) {
        try {
          await deps.disposeAttachment(attachment, 'attachment-sweep');
        } catch (err) {
          log(
            `[attachment-sweep] disposal of ${attachment.channelType}/${attachment.channelKey} failed (kept for retry): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      log(`[attachment-sweep] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), deps.intervalMs ?? SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
