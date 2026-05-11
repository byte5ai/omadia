import type { MemoryStore } from '@omadia/plugin-api';
import type { KnowledgeGraph } from '@omadia/plugin-api';
import { parseSessionTranscript } from './sessionTranscriptParser.js';

export interface BackfillResult {
  scopes: number;
  files: number;
  turns: number;
  skippedFiles: string[];
}

/**
 * On startup, replays every `.md` under `/memories/sessions/<scope>/` into
 * the graph so restarting the middleware doesn't blank the knowledge store.
 * Uses the parser in lockstep with the renderer — any format drift there
 * must be mirrored here, else turns silently get lost.
 */
export async function backfillGraph(
  store: MemoryStore,
  graph: KnowledgeGraph,
): Promise<BackfillResult> {
  const result: BackfillResult = { scopes: 0, files: 0, turns: 0, skippedFiles: [] };

  if (!(await store.directoryExists('/memories/sessions'))) {
    return result;
  }

  const top = await store.list('/memories/sessions');
  const scopeDirs = top.filter(
    (e) => e.isDirectory && e.virtualPath !== '/memories/sessions',
  );

  for (const scopeDir of scopeDirs) {
    result.scopes++;
    const scope = scopeDir.virtualPath.slice('/memories/sessions/'.length);
    const entries = await store.list(scopeDir.virtualPath);
    const files = entries
      .filter((e) => !e.isDirectory && e.virtualPath.endsWith('.md'))
      .sort((a, b) => a.virtualPath.localeCompare(b.virtualPath));

    for (const file of files) {
      result.files++;
      const dayMatch = /\/(\d{4}-\d{2}-\d{2})\.md$/.exec(file.virtualPath);
      if (!dayMatch || dayMatch[1] === undefined) {
        result.skippedFiles.push(file.virtualPath);
        continue;
      }
      const day = dayMatch[1];
      const markdown = await store.readFile(file.virtualPath);
      const turns = parseSessionTranscript(day, markdown);
      for (const turn of turns) {
        await graph.ingestTurn({ scope, ...turn });
        result.turns++;
      }
    }
  }

  return result;
}
