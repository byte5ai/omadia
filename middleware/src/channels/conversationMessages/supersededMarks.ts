// #2089 (spec 2043 §5.3) — a superseded revision is marked on every read
// path. An edited message (or a corrected transcript segment) has a later
// revision; a record of an earlier one is returned with `superseded: true`
// and the latest revision, so a consumer can refuse it as a contribution or
// confirmation instead of counting outdated text.

import type { ConversationMessageRecord } from '@omadia/plugin-api';

import { revisionFamilyKey, type ConversationMessageStore, type MessageSubscription } from './store.js';

export async function markSuperseded<R extends ConversationMessageRecord>(
  store: Pick<ConversationMessageStore, 'latestRevisions'>,
  subscription: MessageSubscription,
  records: readonly R[],
): Promise<R[]> {
  const ids = records.filter((r) => revisionFamilyKey(r.kind, r.messageId) !== undefined).map((r) => r.messageId);
  if (ids.length === 0) return [...records];
  const latest = await store.latestRevisions(subscription, ids);
  return records.map((record) => {
    const key = revisionFamilyKey(record.kind, record.messageId);
    const newest = key === undefined ? undefined : latest.get(key);
    return newest !== undefined && newest > record.revision
      ? { ...record, superseded: true, latestRevision: newest }
      : record;
  });
}
