import type { MemoryToolHandler } from '@omadia/memory';

/**
 * The `/memories` listing, read by the kernel before the turn's first model
 * call instead of by the model.
 *
 * The stable prompt asks the model to read the memory directory at the start
 * of every new task. Measured live, that opening `view` cost a full main-model
 * round on nearly every chat turn (~3–4 s on Opus) for a tool call that takes
 * 10–25 ms. The kernel now makes the same call through the turn's own bound
 * handler — same tree, same partition, same ACL as the model's call — and
 * hands the listing over in the per-turn hint (uncached, so the stable prompt
 * and its cache key stay byte-identical). `memory` results are intern-exempt
 * (`privacyInternPolicy.ts`), so the listing reaches the model exactly as the
 * tool result would have.
 */

const MEMORY_ROOT = '/memories';

/** The handler's directory-listing header (`formatDirectoryListing`); every
 *  error or file read takes a different shape. */
const LISTING_PREFIX = "Here're the files and directories";

/** A listing longer than this is not inlined — the model then keeps the
 *  ordinary read convention for the turn (no partial index). */
export const MEMORY_INDEX_MAX_CHARS = 6000;

/** Why a turn gets no prefetched index — logged, never thrown. */
export type MemoryIndexSkip = 'no-handler' | 'not-a-listing' | 'too-large' | 'failed';

export type MemoryIndexResult =
  | { readonly ok: true; readonly listing: string }
  | { readonly ok: false; readonly reason: MemoryIndexSkip };

export async function prefetchMemoryIndex(
  handler: MemoryToolHandler | undefined,
): Promise<MemoryIndexResult> {
  if (handler === undefined) return { ok: false, reason: 'no-handler' };
  try {
    const listing = await handler.handle({ command: 'view', path: MEMORY_ROOT });
    if (!listing.startsWith(LISTING_PREFIX)) return { ok: false, reason: 'not-a-listing' };
    if (listing.length > MEMORY_INDEX_MAX_CHARS) return { ok: false, reason: 'too-large' };
    return { ok: true, listing };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** The per-turn hint block carrying the prefetched listing. */
export function memoryIndexHint(listing: string): string {
  return `# MEMORY-INDEX (für diesen Turn bereits gelesen)

Die Konvention „zu Beginn jeder neuen Aufgabe den /memories-Verzeichnisinhalt lesen" ist für diesen Turn bereits erfüllt — der aktuelle Inhalt steht unten. Setz KEINEN \`memory\`-View auf \`/memories\` ab. Lies eine konkrete Datei daraus nur, wenn sie zur Anfrage passt; Schreiben bleibt wie gewohnt möglich.

\`\`\`
${listing}
\`\`\``;
}
