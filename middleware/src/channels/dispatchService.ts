import { CHAT_AGENT_SERVICE } from '@omadia/channel-sdk';

import type { ChannelManifestBlock } from '../api/admin-v1.js';

/**
 * Resolve the bare service-registry key a channel's turns dispatch to.
 *
 * A channel manifest may declare `channel.dispatch_service` to route its turns
 * to an alternate orchestrator (Omadia UI's `canvasChatAgent`). When absent —
 * every classic channel — turns dispatch to the shared `chatAgent` orchestrator,
 * exactly as before. The returned value is a BARE registry key: the service
 * registry looks up by exact string and does not strip an `@N` suffix (that
 * lives only in the provider's `provides:`/`requires:` capability list), so a
 * manifest must declare the bare name (`canvasChatAgent`, not `canvasChatAgent@1`).
 *
 * Additive + zero-regression: with no `dispatch_service` declared the result is
 * `CHAT_AGENT_SERVICE`, the same key the dispatcher used unconditionally before.
 */
export function resolveDispatchService(
  channel: ChannelManifestBlock | undefined,
): string {
  return channel?.dispatch_service ?? CHAT_AGENT_SERVICE;
}
