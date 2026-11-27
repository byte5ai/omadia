/**
 * #1753 — a deleted routine or chat takes its markdown transcripts with it
 * (`/memories/sessions/<scope>/`): the orchestrator is told to look there for
 * earlier conversations, and the graph backfill replays those files.
 *
 * ADR-0323 — and its conversation history in the knowledge graph (Turns,
 * Runs, tool calls, plans, Facts derived only from them, the Session), under
 * every Agent that answered in it. Transcripts go first: they are what the
 * backfill would replay into the graph.
 */

import { scopeGraphKey } from '@omadia/channel-sdk';
import { graphScopeKeysFor, sessionTranscriptDir } from '@omadia/orchestrator';
import type { KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

export async function purgeSessionTranscripts(store: Pick<MemoryStore, 'directoryExists' | 'delete'>, scope: string): Promise<void> {
  const dir = sessionTranscriptDir(scope);
  if (!dir) return;
  if (await store.directoryExists(dir)) await store.delete(dir);
}

/**
 * Remove the conversation's graph history. Resolves to the number of deleted
 * nodes, or `undefined` when the graph cannot purge (no graph, or a backend
 * without `purgeConversationHistory`) — said once in the log, never thrown.
 */
export async function purgeConversationGraph(
  graph: Pick<KnowledgeGraph, 'purgeConversationHistory'> | undefined,
  tenantId: string,
  scope: string,
  opts: { readonly injectiveOnly?: boolean; readonly userId?: string } = {},
): Promise<number | undefined> {
  const conversationScopes = opts.injectiveOnly ? [scopeGraphKey(scope)] : graphScopeKeysFor(scope);
  if (conversationScopes.length === 0) return 0;
  if (!graph?.purgeConversationHistory) {
    console.warn(`[conversation-purge] the knowledge graph cannot purge; history of '${scope}' stays`);
    return undefined;
  }
  const { deletedNodes } = await graph.purgeConversationHistory({
    tenantId,
    conversationScopes,
    ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
  });
  if (deletedNodes > 0) {
    console.log(`[conversation-purge] removed ${String(deletedNodes)} graph node(s) of '${scope}'`);
  }
  return deletedNodes;
}

/**
 * Transcripts, then graph history; both for one conversation scope.
 *
 * The transcript directory and the sanitized graph key fold case, while chat
 * ids are stored case-sensitively: a chat id with upper-case letters could
 * name another chat's folded key. Such a scope is purged only by its
 * injective graph key and keeps its transcript directory (web chat and routine
 * ids are lower-case in practice). A failing graph purge is logged here, so
 * the caller's record of the transcript removal stays true.
 */
export async function purgeConversationRecords(
  deps: {
    readonly store: Pick<MemoryStore, 'directoryExists' | 'delete'>;
    readonly graph: () => Pick<KnowledgeGraph, 'purgeConversationHistory'> | undefined;
    readonly tenantId: string;
  },
  scope: string,
  /**
   * The deleting person's omadia user id, for a scope the client named (a web
   * chat id): only that person's turns go. A client-chosen id can share a
   * graph key with a conversation that is not theirs; a routine's scope is
   * minted by the server and needs no owner.
   */
  owner?: { readonly userId: string | undefined },
): Promise<void> {
  const caseFolds = scope !== scope.toLowerCase();
  if (caseFolds) {
    console.warn(`[conversation-purge] '${scope}' has upper-case letters; its transcripts and folded graph key are kept`);
  } else {
    await purgeSessionTranscripts(deps.store, scope);
  }
  if (owner && owner.userId === undefined) {
    console.warn(`[conversation-purge] '${scope}': no omadia user id for the deleting account; graph history kept`);
    return;
  }
  try {
    await purgeConversationGraph(deps.graph(), deps.tenantId, scope, {
      ...(caseFolds ? { injectiveOnly: true } : {}),
      ...(owner?.userId !== undefined ? { userId: owner.userId } : {}),
    });
  } catch (err) {
    console.error(
      `[conversation-purge] graph history of '${scope}' not removed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
