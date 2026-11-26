import type { ChatTurnInput, TurnOrigin } from '@omadia/channel-sdk';

/**
 * #1774 (ADR-0182) — where a web chat or web routine turn came from: the
 * signed-in account's one-person room.
 *
 * ADR-0145 left HTTP turns without an origin because the route only knew
 * caller-chosen labels (scope, `sessionId`), and a partition named by one of
 * those would let a client name another caller's tier. This origin is built
 * from the authenticated session's canonical omadia user id instead, never
 * from the request body or a header, so it names the caller's own tier only.
 *
 * `channelType` is `http`, which `CONTEXT_MEMORY_CHANNEL_TYPES` already
 * admits; the personal scope maps to the `user` axis
 * (`/memories/contexts/<slug>/user/<key>/`), and under `members` to a
 * one-person audience.
 */
export const WEB_ACCOUNT_CHANNEL_TYPE = 'http';

export function webAccountOrigin(omadiaUserId: string): TurnOrigin {
  return {
    channelType: WEB_ACCOUNT_CHANNEL_TYPE,
    scope: { kind: 'personal', userId: omadiaUserId },
    conversationType: 'direct',
  };
}

/**
 * Is this a web account turn whose user id IS the account's canonical id?
 * Both halves come from the session (chat route, web routine runner), so the
 * one person present is that id without an identity lookup. A turn with a
 * channel identity is a channel turn, never this.
 */
export function isWebAccountTurn(
  input: Pick<ChatTurnInput, 'userId' | 'channelIdentity' | 'origin'>,
): input is Pick<ChatTurnInput, 'channelIdentity' | 'origin'> & { userId: string } {
  const origin = input.origin;
  return (
    input.channelIdentity === undefined &&
    origin?.channelType === WEB_ACCOUNT_CHANNEL_TYPE &&
    origin.scope.kind === 'personal' &&
    typeof input.userId === 'string' &&
    input.userId.length > 0 &&
    origin.scope.userId === input.userId
  );
}
