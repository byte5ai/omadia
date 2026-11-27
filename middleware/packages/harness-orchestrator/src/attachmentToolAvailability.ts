import { currentToolCallContext } from './toolCallContext.js';

/**
 * Turn sources that never carry a user upload: the web chat and the HTTP API
 * (no origin and no channel user, or one of these types) and kernel-started
 * turns.
 */
const NO_UPLOAD_CHANNEL_TYPES: ReadonlySet<string> = new Set(['http', 'api', 'web', 'timer']);

/**
 * #1976 — may this turn carry an uploaded file? `read_attachment` and
 * `transcribe_recording` read stored uploads by key, so they are offered only
 * on a turn that came in through a messaging channel. The web chat has no
 * file upload: offering them there made the model ask for a re-upload and
 * point the user at internal markup. Constant for the turn, as
 * `isAvailable` requires; outside a turn it is `false`.
 */
export function turnMayCarryUploads(): boolean {
  // Both carriers: the in-process orchestrator's turn context and the
  // subscription-CLI runtime's own tool-call store.
  const context = currentToolCallContext();
  const channelType = context?.channelType;
  if (typeof channelType === 'string' && channelType !== '') {
    return !NO_UPLOAD_CHANNEL_TYPES.has(channelType);
  }
  // An older channel plugin sends no origin, but still names its user: a
  // channel user is a messaging channel, which may carry uploads.
  return context?.callerUserRef !== undefined;
}
