/**
 * The one principal of a person inside a group conversation (ADR 0032):
 * `user:<channel user id>`, trimmed and lower-cased (`makePrincipal`).
 *
 * Every path that names a person to a facilitation uses this helper: the
 * caller of a tool call (`buildToolCallContext`), the author of a stored
 * message and a roster participant (`principalOfChannelUser`), and the
 * caller of an engine turn (`agentTurn@2`). It is NOT the routing principal
 * of spec 2042 §5.3 (`channelUserPrincipal`: `user:<e-mail>` or
 * `user:<kind>:<id>`), which keys selections and availability.
 */

import { formatPrincipal, makePrincipal } from '@omadia/channel-sdk';

export function conversationPrincipal(channelUserId: string | undefined): string | undefined {
  if (channelUserId === undefined) return undefined;
  const principal = makePrincipal('user', channelUserId);
  return principal ? formatPrincipal(principal) : undefined;
}
