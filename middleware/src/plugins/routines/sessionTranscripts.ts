/**
 * #1753 — a deleted routine or chat takes its markdown transcripts with it
 * (`/memories/sessions/<scope>/`): the orchestrator is told to look there for
 * earlier conversations, and the graph backfill replays those files.
 */

import { sessionTranscriptDir } from '@omadia/orchestrator';
import type { MemoryStore } from '@omadia/plugin-api';

export async function purgeSessionTranscripts(store: Pick<MemoryStore, 'directoryExists' | 'delete'>, scope: string): Promise<void> {
  const dir = sessionTranscriptDir(scope);
  if (!dir) return;
  if (await store.directoryExists(dir)) await store.delete(dir);
}
