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
export async function resolveTurnOwnerIdentity(
  knowledgeGraph: KnowledgeGraph | undefined,
  input: Pick<ChatTurnInput, 'userId' | 'channelIdentity'>,
): Promise<string | undefined> {
  if (!input.channelIdentity) return input.userId;
  // No KnowledgeGraph wired up ⇒ no way to resolve a channel identity into a
  // canonical uuid. Deliberately returns undefined rather than guessing with
  // the raw channel-native id — callers (dataset ACL checks) must degrade to
  // "no identity available" rather than silently using the wrong id.
  if (!knowledgeGraph) return undefined;
  try {
    const { omadiaUserId } = await knowledgeGraph.resolveOrCreateChannelIdentity({
      channelKind: input.channelIdentity.channelKind,
      channelUserId: input.channelIdentity.channelUserId,
    });
    return omadiaUserId;
  } catch (err) {
    console.warn(
      `[harness-orchestrator] resolveTurnOwnerIdentity: channel identity resolution failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}
