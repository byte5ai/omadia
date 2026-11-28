import { makePrincipal, type ChatTurnInput, type Principal } from '@omadia/channel-sdk';
import type { ChannelIdentityIngest, ChannelKind, KnowledgeGraph } from '@omadia/plugin-api';

import { isWebAccountTurn } from './webAccountOrigin.js';

/** The `TurnOrigin.channelType` values that map onto a KG channel kind. */
export const CHANNEL_KIND_BY_ORIGIN: Readonly<Record<string, ChannelKind>> = {
  teams: 'teams',
  telegram: 'telegram',
  // #2042 — the colleague channels: a group turn needs a kind to establish
  // its audience (an unknown audience answers nothing, fail-closed).
  slack: 'slack',
  discord: 'discord',
  whatsapp: 'whatsapp',
  imessage: 'imessage',
  api: 'api',
};

/**
 * #1994 — the channel kind of a turn: the minted channel identity's kind, or,
 * for a plugin channel turn that carries none (Telegram, Teams, Slack, …), the
 * kind its `origin` names. Every consumer (receipts, AI disclosure, audience)
 * reads this one derivation.
 */
export function turnChannelKind(
  input: Pick<ChatTurnInput, 'channelIdentity' | 'origin'>,
): ChannelKind | undefined {
  return (
    input.channelIdentity?.channelKind ??
    (input.origin ? CHANNEL_KIND_BY_ORIGIN[input.origin.channelType] : undefined)
  );
}

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
  /**
   * ADR-0225 — the `users.id` an operator linked this turn's channel identity
   * to. Set only for a plugin channel turn (identity stated through `origin`)
   * whose identity carries such a link; {@link omadiaUserId}, `principal` and
   * `authSubjectKey` then name that account's cluster, and the turn may key
   * `per_user` MCP tokens on it ({@link channelTurnMcpUserKey}).
   */
  linkedUserId?: string;
  /**
   * ADR-0300 — the person key (AAD object id) of the active directory person
   * this turn's sender is: a Teams sender whose object id the directory
   * lists, or a channel identity an operator linked to a directory person.
   * `per_user` MCP tokens of a person without a web login are stored under it
   * ({@link channelTurnMcpUserKey}).
   */
  directoryPersonKey?: string;
  /** ADR-0300 — the directory person an operator linked this channel identity to. */
  linkedDirectoryPersonId?: string;
  /**
   * The cluster of the identity a plugin channel turn states through `origin`,
   * linked or not — resolved here once so the run-trace owner
   * ({@link resolveRunTraceOwner}) does not resolve it a second time.
   */
  originClusterUserId?: string;
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

/**
 * ADR-0300 / #2324 — what the kernel knows about people and accounts that the
 * knowledge graph does not: whether an account is still active, and which
 * directory people are. The orchestrator has no database; the kernel
 * publishes this as `turnIdentityDirectory@1`. Absent: no directory key is
 * produced and links apply as recorded.
 */
export interface TurnIdentityDirectory {
  /** `false` when the account (`users.id`) is disabled or gone. */
  isAccountActive(userId: string): Promise<boolean>;
  /** The person key of the ACTIVE directory person with this AAD object id. */
  activePersonKeyByObjectId(aadObjectId: string): Promise<string | undefined>;
  /** The person key of the ACTIVE directory person with this directory id. */
  activePersonKeyById(personId: string): Promise<string | undefined>;
}

/** A lookup that fails reads as "not a person": no key is produced. */
async function personKeyOrNone(
  lookup: () => Promise<string | undefined>,
): Promise<string | undefined> {
  try {
    return (await lookup()) || undefined;
  } catch (err) {
    console.warn(
      `[harness-orchestrator] resolveTurnOwnerIdentity: directory lookup failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

/** The directory key of a Teams sender: their AAD object id, when the directory lists them as active. */
async function teamsDirectoryKey(
  directory: TurnIdentityDirectory | undefined,
  channelKind: ChannelKind,
  aadObjectId: string | undefined,
): Promise<{ directoryPersonKey?: string }> {
  if (!directory || channelKind !== 'teams' || !aadObjectId || aadObjectId.startsWith('29:')) return {};
  const key = await personKeyOrNone(() => directory.activePersonKeyByObjectId(aadObjectId));
  return key ? { directoryPersonKey: key } : {};
}

export async function resolveTurnOwnerIdentity(
  knowledgeGraph: KnowledgeGraph | undefined,
  input: Pick<ChatTurnInput, 'userId' | 'channelIdentity'> & Partial<Pick<ChatTurnInput, 'origin'>>,
  directory?: TurnIdentityDirectory,
): Promise<TurnOwnerIdentity> {
  if (!input.channelIdentity) {
    const implicit = originChannelIdentity(input);
    if (implicit && knowledgeGraph) return resolveOriginTurnOwner(knowledgeGraph, input, implicit, directory);
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
    const { omadiaUserId, clusterAuthSubject, linkedUserId, linkedDirectoryPersonId } =
      await knowledgeGraph.resolveOrCreateChannelIdentity({
        channelKind: input.channelIdentity.channelKind,
        channelUserId: input.channelIdentity.channelUserId,
      });
    // #2324 / ADR-0300 — a minted channel identity (the dispatcher's
    // `userRef` path) already sits in the cluster an operator linked it to.
    // A link to a disabled account or a deprovisioned person names nobody:
    // the turn gets no identity at all (fail closed), not the cluster.
    if (linkedUserId && directory && !(await accountActiveOrFalse(directory, linkedUserId))) {
      console.warn(
        `[security-audit] resolveTurnOwnerIdentity: ${input.channelIdentity.channelKind} identity is linked to inactive account ${linkedUserId} — no turn identity`,
      );
      return {};
    }
    if (linkedDirectoryPersonId && omadiaUserId) {
      const key = directory ? await personKeyOrNone(() => directory.activePersonKeyById(linkedDirectoryPersonId)) : undefined;
      if (!key) return {};
      return withPrincipal({ omadiaUserId, directoryPersonKey: key, linkedDirectoryPersonId });
    }
    return withPrincipal({
      ...(omadiaUserId ? { omadiaUserId } : {}),
      // ADR-0225 — the minted identity sits in the account cluster an
      // operator linked it to; say so, like the origin path does.
      ...(linkedUserId && omadiaUserId ? { linkedUserId } : {}),
      ...(clusterAuthSubject
        ? { authSubjectKey: clusterAuthSubject.providerUserId }
        : {}),
      ...(await teamsDirectoryKey(
        directory,
        input.channelIdentity.channelKind,
        input.channelIdentity.channelUserId,
      )),
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

/** A failed account lookup counts as inactive: the link is not applied. */
async function accountActiveOrFalse(directory: TurnIdentityDirectory, userId: string): Promise<boolean> {
  try {
    return await directory.isAccountActive(userId);
  } catch (err) {
    console.warn(
      `[harness-orchestrator] resolveTurnOwnerIdentity: account lookup failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/**
 * ADR-0300 — a channel identity an operator linked to a directory person runs
 * as the person's cluster and keys `per_user` tokens on the person, while the
 * person is active. Deprovisioned, unknown, or no directory: the raw id, as an
 * unlinked identity.
 */
async function withLinkedPerson(
  clusterUserId: string,
  personId: string,
  directory: TurnIdentityDirectory | undefined,
  legacy: TurnOwnerIdentity,
  originCluster: { originClusterUserId?: string },
): Promise<TurnOwnerIdentity> {
  const key = directory ? await personKeyOrNone(() => directory.activePersonKeyById(personId)) : undefined;
  if (!key) return { ...legacy, ...originCluster };
  return withPrincipal({
    omadiaUserId: clusterUserId,
    directoryPersonKey: key,
    linkedDirectoryPersonId: personId,
    ...originCluster,
  });
}

/**
 * ADR-0225 — a plugin channel turn (Telegram, Teams, …) names its sender only
 * through `origin` + `userId`. Unlinked, it keeps running as that raw id, as
 * it always did: its datasets and keys were written under it. Linked by an
 * operator, it runs as the account's cluster: canonical id, principal and IdP
 * subject all come from the cluster the link joined. The channel attests the
 * sender; only the kernel-recorded link decides the account.
 */
async function resolveOriginTurnOwner(
  knowledgeGraph: KnowledgeGraph,
  input: Pick<ChatTurnInput, 'userId'>,
  implicit: ChannelIdentityIngest,
  directory: TurnIdentityDirectory | undefined,
): Promise<TurnOwnerIdentity> {
  const legacy: TurnOwnerIdentity = input.userId ? withPrincipal({ omadiaUserId: input.userId }) : {};
  try {
    const resolved = await knowledgeGraph.resolveOrCreateChannelIdentity(implicit);
    const originCluster = resolved.omadiaUserId ? { originClusterUserId: resolved.omadiaUserId } : {};
    if (resolved.linkedDirectoryPersonId && resolved.omadiaUserId) {
      return withLinkedPerson(resolved.omadiaUserId, resolved.linkedDirectoryPersonId, directory, legacy, originCluster);
    }
    if (!resolved.linkedUserId || !resolved.omadiaUserId) {
      return {
        ...legacy,
        ...originCluster,
        ...(await teamsDirectoryKey(directory, implicit.channelKind, implicit.aadObjectId)),
      };
    }
    // #2324 — a link to a disabled (or deleted) account names nobody: the
    // turn runs as the raw channel id again until the account is enabled.
    if (directory && !(await accountActiveOrFalse(directory, resolved.linkedUserId))) {
      console.warn(
        `[security-audit] resolveTurnOwnerIdentity: ${implicit.channelKind} identity is linked to inactive account ${resolved.linkedUserId} — link not applied`,
      );
      return { ...legacy, ...originCluster };
    }
    return withPrincipal({
      omadiaUserId: resolved.omadiaUserId,
      ...(resolved.clusterAuthSubject
        ? { authSubjectKey: resolved.clusterAuthSubject.providerUserId }
        : {}),
      linkedUserId: resolved.linkedUserId,
      ...originCluster,
    });
  } catch (err) {
    console.warn(
      `[harness-orchestrator] resolveTurnOwnerIdentity: origin identity resolution failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return legacy;
  }
}

/**
 * The `mcpUserKey` a channel turn produces itself (the HTTP path sets its own
 * in an outer scope, which always wins). A turn with a minted
 * `channelIdentity`, or a plugin channel turn whose identity an operator
 * linked (ADR-0225), keys on its cluster: the IdP subject when the cluster has
 * one, else the canonical id. Any other turn produces none — its `userId` may
 * come from a client-controlled header.
 */
export function channelTurnMcpUserKey(
  input: Pick<ChatTurnInput, 'channelIdentity'>,
  owner: TurnOwnerIdentity,
): string | undefined {
  if (!input.channelIdentity && !owner.linkedUserId) return owner.directoryPersonKey || undefined;
  return owner.authSubjectKey || owner.directoryPersonKey || owner.omadiaUserId || undefined;
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
  originClusterUserId?: string,
): Promise<string | undefined> {
  const implicit = originChannelIdentity(input);
  if (!implicit) return runTraceOwnerId(input, resolvedOmadiaUserId);
  if (!knowledgeGraph) return undefined;
  // Already resolved for the turn owner (same identity, same graph).
  if (originClusterUserId) return originClusterUserId;
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

/**
 * ADR-0290 / ADR-0355 — the omadia account a turn speaks for, as the
 * canonical omadia user id (the session's `omadia_user_id`, i.e. the account's
 * User-Cluster). A web account turn takes it from the session (chat route, web
 * routine runner); a channel turn only through an operator's link (ADR-0225).
 * Every other turn — an unlinked channel identity, a directory person without
 * an account, an HTTP turn whose `userId` a client may have chosen — speaks for
 * no account and gets `undefined`. Never derived from tool input.
 */
export function turnAccountUserId(
  input: Pick<ChatTurnInput, 'userId' | 'channelIdentity' | 'origin'>,
  owner: Pick<TurnOwnerIdentity, 'omadiaUserId' | 'linkedUserId'>,
): string | undefined {
  if (isWebAccountTurn(input)) return input.userId.trim() || undefined;
  if (owner.linkedUserId && owner.omadiaUserId) return owner.omadiaUserId;
  return undefined;
}
