import { makePrincipal, type ChatTurnInput, type Principal } from '@omadia/channel-sdk';
import type { ChannelIdentityIngest, ChannelKind, KnowledgeGraph } from '@omadia/plugin-api';

/** The `TurnOrigin.channelType` values that map onto a KG channel kind. */
export const CHANNEL_KIND_BY_ORIGIN: Readonly<Record<string, ChannelKind>> = {
  teams: 'teams',
  telegram: 'telegram',
  api: 'api',
};

/**
 * The channel identity a plugin channel turn carries implicitly: no
 * `channelIdentity` (that is minted only by `createOrchestratorDispatcher`),
 * but an `origin` naming a channel and `userId` holding the sender's
 * channel-native id. The Teams plugin calls `ChatAgent.chat` this way with the
 * sender's AAD object id. `origin` is set only by channel plugins — no HTTP
 * route sets it — so this is as adapter-attested as the dispatcher's
 * `userRef`.
 *
 * Teams keys a sender on `from.aadObjectId ?? from.id`; an AAD id is passed as
 * such so the identity layer merges it into the person's existing cluster
 * (exactly as `resolveTurnAudience` does). A Bot Framework `29:` id is not one.
 */
export function originChannelIdentity(
  input: Pick<ChatTurnInput, 'userId' | 'channelIdentity' | 'origin'>,
): ChannelIdentityIngest | undefined {
  if (input.channelIdentity || !input.origin || !input.userId) return undefined;
  const channelKind = CHANNEL_KIND_BY_ORIGIN[input.origin.channelType];
  if (!channelKind) return undefined;
  return {
    channelKind,
    channelUserId: input.userId,
    ...(channelKind === 'teams' && !input.userId.startsWith('29:')
      ? { aadObjectId: input.userId }
      : {}),
  };
}

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
  /**
   * Issue #333 — the turn owner as a `Principal`, the platform-wide way to name
   * *who* a decision is about. This is the widening the Phase-0 spec (§6) calls
   * for: #691 answered identity as two loose optional strings, and #575 needs a
   * subject it can intersect entitlements over without re-deriving one.
   *
   * Derived from {@link TurnOwnerIdentity.omadiaUserId} only, never from
   * `authSubjectKey`. An IdP subject names an account at a *provider*; a
   * `Principal` names a subject in omadia's own id space. They are not
   * interchangeable, and a turn whose cluster has a login but no canonical
   * omadia id has no principal — the same fail-closed absence `omadiaUserId`
   * already expresses.
   *
   * Always the `user` kind. A `role:` principal is a late-bound indirection
   * over holders, which nothing about a single turn's caller can produce.
   */
  principal?: Principal;
}

/**
 * #333 — attaches the `Principal` projection of an identity answer.
 *
 * A single place so both return paths agree by construction. `makePrincipal`
 * canonicalizes, and refuses a blank id rather than minting a principal no
 * binding row can ever match.
 */
function withPrincipal(identity: TurnOwnerIdentity): TurnOwnerIdentity {
  const principal = identity.omadiaUserId ? makePrincipal('user', identity.omadiaUserId) : undefined;
  return principal ? { ...identity, principal } : identity;
}

export async function resolveTurnOwnerIdentity(
  knowledgeGraph: KnowledgeGraph | undefined,
  input: Pick<ChatTurnInput, 'userId' | 'channelIdentity'>,
): Promise<TurnOwnerIdentity> {
  if (!input.channelIdentity) {
    // Non-channel turns carry no cluster to read a subject from; the HTTP
    // path produces its own `mcpUserKey` from the live session instead.
    return input.userId ? withPrincipal({ omadiaUserId: input.userId }) : {};
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
    return withPrincipal({
      ...(omadiaUserId ? { omadiaUserId } : {}),
      ...(clusterAuthSubject
        ? { authSubjectKey: clusterAuthSubject.providerUserId }
        : {}),
    });
  } catch (err) {
    console.warn(
      `[harness-orchestrator] resolveTurnOwnerIdentity: channel identity resolution failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {};
  }
}

/**
 * The user a turn's run trace is filed under in the knowledge graph.
 *
 * `ingestRun` links the Run to an EXISTING User-Cluster (`user:<omadiaUserId>`)
 * and refuses to create one, so the id it gets has to be the cluster root. A
 * channel turn's `input.userId` is the raw channel-native id (`key:<uuid>` for
 * the API channel, an AAD oid for Teams), which names no cluster: every such
 * trace was dropped as `run-ingest-failed` while the stream reported success.
 * The canonical id was already resolved for the turn (`resolvedOmadiaUserId`
 * on the turn context), so a channel turn uses that, and a turn whose identity
 * could not be resolved files its trace without a user link rather than under
 * an id no cluster carries.
 *
 * A non-channel turn keeps `input.userId`: on the HTTP path that already IS
 * the session's canonical id, and `resolveTurnOwnerIdentity` passes it through
 * verbatim.
 */
export function runTraceOwnerId(
  input: Pick<ChatTurnInput, 'userId' | 'channelIdentity'>,
  resolvedOmadiaUserId: string | undefined,
): string | undefined {
  if (input.channelIdentity) return resolvedOmadiaUserId || undefined;
  return input.userId || undefined;
}

/**
 * The run-trace owner, resolved once at the start of the turn — before
 * `ingestRun` needs it.
 *
 * {@link runTraceOwnerId} covers turns with a `channelIdentity` and HTTP
 * turns. A plugin channel turn that states its channel only through `origin`
 * (Teams: `userId` = the sender's AAD object id) had neither: its raw AAD id
 * went to `ingestRun`, which names no User-Cluster, and every such trace was
 * dropped as `run-ingest-failed`. This resolves that sender through the
 * identity resolver (`resolveOrCreateChannelIdentity`, the same call and the
 * same AAD merge `resolveTurnAudience` uses), which links a cluster to the
 * channel identity — `ingestRun` itself still never creates one.
 *
 * Only the trace owner. The turn's `resolvedOmadiaUserId` — dataset ACLs, MCP
 * keys, the `Principal` — is untouched for these turns. Every participant of a
 * group chat resolves to their own cluster, so traces stay per person. No
 * knowledge graph, or a failed resolution: the trace is filed without a user
 * link, never under an id no cluster carries.
 */
export async function resolveRunTraceOwner(
  knowledgeGraph: KnowledgeGraph | undefined,
  input: Pick<ChatTurnInput, 'userId' | 'channelIdentity' | 'origin'>,
  resolvedOmadiaUserId: string | undefined,
): Promise<string | undefined> {
  const implicit = originChannelIdentity(input);
  if (!implicit) return runTraceOwnerId(input, resolvedOmadiaUserId);
  if (!knowledgeGraph) return undefined;
  try {
    const { omadiaUserId } = await knowledgeGraph.resolveOrCreateChannelIdentity(implicit);
    return omadiaUserId || undefined;
  } catch (err) {
    console.warn(
      `[harness-orchestrator] resolveRunTraceOwner: channel identity resolution failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}
