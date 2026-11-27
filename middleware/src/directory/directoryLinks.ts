// ADR-0300 — a directory person in the knowledge graph.
//
// A person has no account and no cluster of their own: their cluster is the
// one that holds their Teams identity (`teams:<AAD object id>`, merged by the
// object id like an Entra login). An operator link from another channel
// (Telegram, …) joins that cluster and records `linkedDirectoryPersonId`.

import type { ChannelKind, KnowledgeGraph } from '@omadia/plugin-api';

import { systemAuditActor, type AuditEntryInput } from '../auth/adminAuditLog.js';
import type { DirectoryPerson } from './directoryStore.js';

/** The cluster of the person's Teams identity, created like a first Teams turn would. */
export async function personClusterOf(kg: KnowledgeGraph, person: DirectoryPerson): Promise<string> {
  const resolved = await kg.resolveOrCreateChannelIdentity({
    channelKind: 'teams',
    channelUserId: person.externalId,
    aadObjectId: person.externalId,
    ...(person.displayName ? { displayName: person.displayName } : {}),
  });
  return resolved.omadiaUserId;
}

/** Channel kinds that join a person only by operator link (never Teams itself, never accounts). */
const LINKED_KINDS: ReadonlySet<ChannelKind> = new Set<ChannelKind>([
  'telegram',
  'slack',
  'discord',
  'whatsapp',
  'imessage',
]);

/** The channel identities linked to this person, as `{ channelKind, channelUserId }`. */
export async function linkedIdentitiesOf(
  kg: KnowledgeGraph,
  person: DirectoryPerson,
): Promise<{ channelKind: ChannelKind; channelUserId: string }[]> {
  if (!kg.listUserChannelIdentities || !kg.findOmadiaUserIdByChannelIdentity) return [];
  // Read-only: a person never seen in Teams has no cluster yet, so nothing is linked.
  const cluster = await kg.findOmadiaUserIdByChannelIdentity('teams', person.externalId);
  if (!cluster) return [];
  const identities = await kg.listUserChannelIdentities(cluster);
  const linked: { channelKind: ChannelKind; channelUserId: string }[] = [];
  for (const identity of identities) {
    if (!LINKED_KINDS.has(identity.channelKind)) continue;
    const resolved = await kg.resolveOrCreateChannelIdentity({
      channelKind: identity.channelKind,
      channelUserId: identity.channelUserId,
    });
    if (resolved.linkedDirectoryPersonId === person.id) linked.push(identity);
  }
  return linked;
}

/**
 * Removes every operator link to the person (deprovisioning). Each unlink is
 * audited first; a failed audit write is logged and the unlink still happens,
 * because a leaver's channel accounts must not keep running as them.
 */
export async function unlinkPersonIdentities(
  kg: KnowledgeGraph | undefined,
  audit: { record(entry: AuditEntryInput): Promise<void> } | undefined,
  person: DirectoryPerson,
  log: (message: string) => void,
): Promise<number> {
  if (!kg?.linkChannelIdentity) return 0;
  let count = 0;
  for (const identity of await linkedIdentitiesOf(kg, person)) {
    try {
      await audit?.record({
        actor: systemAuditActor('system:directory-sync'),
        action: 'channel_identity.unlink',
        target: `channel_identity:${identity.channelKind}:${identity.channelUserId}`,
        before: { linkedDirectoryPersonId: person.id },
        after: null,
      });
    } catch (err) {
      log(`[directory] audit of unlinking ${identity.channelKind} failed — ${err instanceof Error ? err.message : String(err)}`);
    }
    await kg.linkChannelIdentity({ ...identity, target: null });
    count += 1;
  }
  return count;
}
