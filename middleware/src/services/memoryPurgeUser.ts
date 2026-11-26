import type { ChannelKind, KnowledgeGraph, ProcessMemoryService } from '@omadia/plugin-api';

/**
 * The person behind a memory purge on the `user` axis (#1840, #1842, #1843,
 * ADR-0186).
 *
 * The admin UI shows an account's `users.id`; the knowledge graph keys a
 * person by the omadia user id of their `User` cluster; a channel-only user
 * (Telegram, Slack, …) exists only as a `ChannelIdentity`. The purge resolves
 * any of the three to the omadia user id before it plans, so the selector an
 * operator can actually copy finds the person's data, and says which reading
 * it took.
 *
 * With a resolved person the purge also reaches what belongs to them beyond
 * memory and conversations: their datasets, the processes they created and
 * their identity nodes (display name, e-mail).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CHANNEL_KINDS: ReadonlySet<string> = new Set<ChannelKind>([
  'teams',
  'telegram',
  'slack',
  'discord',
  'whatsapp',
  'imessage',
  'email',
  'web',
  'api',
]);

/** How the selector was read. `unresolved`: a uuid no cluster or account has. */
export type UserSelectorVia = 'omadia_user_id' | 'account_id' | 'channel_identity' | 'unresolved';

export interface ResolvedPurgeUser {
  readonly omadiaUserId: string;
  readonly via: UserSelectorVia;
}

/**
 * Read a `user`-axis selector. `null` for a selector that names no person
 * (a context key the graph knows no identity for): the purge then works on
 * the scratch context trees only, as before.
 */
export async function resolveUserSelector(
  kg: KnowledgeGraph | undefined,
  selector: string,
): Promise<ResolvedPurgeUser | null> {
  if (UUID.test(selector)) {
    if (!kg?.countUserIdentity) return { omadiaUserId: selector, via: 'omadia_user_id' };
    if ((await kg.countUserIdentity(selector)).count > 0) {
      return { omadiaUserId: selector, via: 'omadia_user_id' };
    }
    const account = await kg.findOmadiaUserIdByChannelIdentity?.('web', selector);
    if (account) return { omadiaUserId: account, via: 'account_id' };
    return { omadiaUserId: selector, via: 'unresolved' };
  }
  const tilde = selector.indexOf('~');
  if (tilde <= 0) return null;
  const kind = selector.slice(0, tilde);
  const id = selector.slice(tilde + 1);
  if (!CHANNEL_KINDS.has(kind) || id.length === 0) return null;
  const found = await kg?.findOmadiaUserIdByChannelIdentity?.(kind as ChannelKind, id);
  return found ? { omadiaUserId: found, via: 'channel_identity' } : null;
}

/** What a user purge removes beyond memory and conversations. */
export interface UserDataCounts {
  datasets: number;
  processes: number;
  identity: number;
}

export interface UserDataDeps {
  kg?: KnowledgeGraph;
  processMemory?: ProcessMemoryService;
}

/** Page size for walking a person's datasets. */
const DATASET_PAGE = 200;

async function datasetIdsOf(kg: KnowledgeGraph, omadiaUserId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; ; offset += DATASET_PAGE) {
    const page = await kg.listDatasets({ ownerOmadiaUserId: omadiaUserId, limit: DATASET_PAGE, offset });
    ids.push(...page.map((d) => d.id));
    if (page.length < DATASET_PAGE) return ids;
  }
}

export async function countUserData(deps: UserDataDeps, omadiaUserId: string): Promise<UserDataCounts> {
  const { kg, processMemory } = deps;
  const datasets = kg
    ? (kg.countDatasets ? await kg.countDatasets({ ownerOmadiaUserId: omadiaUserId }) : (await datasetIdsOf(kg, omadiaUserId)).length)
    : 0;
  return {
    datasets,
    processes: processMemory?.countByCreator ? (await processMemory.countByCreator(omadiaUserId)).count : 0,
    identity: kg?.countUserIdentity ? (await kg.countUserIdentity(omadiaUserId)).count : 0,
  };
}

/**
 * Delete them, filling `deleted` as each layer finishes. The identity nodes
 * go last: a later step must still resolve the person.
 */
export async function purgeUserData(
  deps: UserDataDeps,
  omadiaUserId: string,
  deleted: UserDataCounts,
): Promise<void> {
  const { kg, processMemory } = deps;
  if (kg) {
    for (const id of await datasetIdsOf(kg, omadiaUserId)) {
      // The purge acts for the owner: deleteDataset is owner-only.
      if (await kg.deleteDataset(id, { actorOmadiaUserId: omadiaUserId, reason: 'memory purge, user axis' })) {
        deleted.datasets++;
      }
    }
  }
  if (processMemory?.purgeByCreator) {
    deleted.processes = (await processMemory.purgeByCreator(omadiaUserId)).deleted;
  }
  if (kg?.purgeUserIdentity) {
    deleted.identity = (await kg.purgeUserIdentity(omadiaUserId)).deletedNodes;
  }
}

/** Which of the three layers the backends cannot reach (named in a warning). */
export function unsupportedUserLayers(deps: UserDataDeps): string[] {
  const missing: string[] = [];
  if (!deps.processMemory?.purgeByCreator) missing.push('processes');
  if (!deps.kg?.purgeUserIdentity) missing.push('identity');
  return missing;
}
