import type { ChatTurnInput } from '@omadia/channel-sdk';
import type { KnowledgeGraph } from '@omadia/plugin-api';

/**
 * #430 fixup (reviewer round 5) — resolves the ONE canonical `omadiaUserId`
 * for a turn, once, so every turn-scoped consumer that needs the caller's
 * identity for a KnowledgeGraph ACL (dataset ownership on import, dataset
 * ownership on query, …) reads the SAME value instead of re-deriving it
 * independently. Before this, `ingestAttachments` resolved
 * `input.channelIdentity` into a canonical id for the IMPORT path only;
 * `QueryDatasetTool` read the raw `turnContext.current()?.userId` for the
 * QUERY path — for a channel turn (Teams/Slack/Telegram) that raw id is the
 * channel-native id (Teams AAD oid, …), never the canonical uuid, so a
 * dataset a channel user just imported could never be found again by that
 * same user in that same channel.
 *
 * Mirrors the exact fallback `ingestAttachments` already implemented:
 * `input.channelIdentity` present → resolve via
 * `KnowledgeGraph.resolveOrCreateChannelIdentity` (idempotent — re-resolving
 * the same `(channelKind, channelUserId)` pair is safe and returns the same
 * id); absent → `input.userId` already IS the canonical uuid (HTTP/CLI turns,
 * and channel kinds the KG model doesn't cover yet) so it's used as-is.
 */
export interface TurnOwnerIdentity {
  /**
   * The canonical omadia user id — what KnowledgeGraph ACLs (dataset
   * ownership on import and on query) key on.
   */
  omadiaUserId?: string;
  /**
   * Issue #568 — the IdP subject of the cluster this turn's caller belongs
   * to, i.e. the session `sub` under which a `per_user` MCP OAuth token was
   * stored by `/mcp-servers/:id/authorize`.
   *
   * Present only when SOME identity in the caller's cluster has been
   * through an authenticating login. A channel-only user has none, and the
   * `per_user` server then fails closed exactly as before — absence must be
   * read as "no token to inherit", never as licence to substitute a key.
   */
  authSubjectKey?: string;
}

export async function resolveTurnOwnerIdentity(
  knowledgeGraph: KnowledgeGraph | undefined,
  input: Pick<ChatTurnInput, 'userId' | 'channelIdentity'>,
): Promise<TurnOwnerIdentity> {
  if (!input.channelIdentity) {
    // Non-channel turns carry no cluster to read a subject from; the HTTP
    // path produces its own `mcpUserKey` from the live session instead.
    return input.userId ? { omadiaUserId: input.userId } : {};
  }
  // No KnowledgeGraph wired up ⇒ no way to resolve a channel identity into a
  // canonical uuid. Deliberately returns nothing rather than guessing with
  // the raw channel-native id — callers (dataset ACL checks) must degrade to
  // "no identity available" rather than silently using the wrong id.
  if (!knowledgeGraph) return {};
  try {
    const { omadiaUserId, clusterAuthSubject } =
      await knowledgeGraph.resolveOrCreateChannelIdentity({
        channelKind: input.channelIdentity.channelKind,
        channelUserId: input.channelIdentity.channelUserId,
      });
    return {
      ...(omadiaUserId ? { omadiaUserId } : {}),
      ...(clusterAuthSubject
        ? { authSubjectKey: clusterAuthSubject.providerUserId }
        : {}),
    };
  } catch (err) {
    console.warn(
      `[harness-orchestrator] resolveTurnOwnerIdentity: channel identity resolution failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {};
  }
}
