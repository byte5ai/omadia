/**
 * KG health snapshot — a pure projection of the installed registry into the
 * capability picture that actually governs recall behaviour.
 *
 * Motivation: the embedding pipeline degrades SILENTLY. A deployment can have a
 * neon backend and an Ollama sidecar yet still run FTS-only (no semantic
 * recall, inert durable tier, no process-reuse) just because
 * `ollama_base_url` never reached the embeddings plugin config. That state was
 * only visible by reading boot logs. This snapshot surfaces it on `/health` so
 * the degradation is observable at a glance instead of diagnosed by archaeology.
 */
import type { InstalledRegistry } from '../plugins/installedRegistry.js';

const KG_NEON_ID = '@omadia/knowledge-graph-neon';
const KG_INMEMORY_ID = '@omadia/knowledge-graph-inmemory';
const EMBEDDINGS_ID = '@omadia/embeddings';

export interface KgHealth {
  /** Active knowledge-graph backend. `none` means recall is fully unavailable. */
  backend: 'neon' | 'inmemory' | 'none';
  /** Whether KG state survives a process restart (neon = durable, inmemory = volatile). */
  durable: boolean;
  /** Whether the embeddings capability is configured (Ollama URL present + active). */
  embeddings: boolean;
  /** Semantic (vector) recall — requires embeddings. */
  semanticRecall: boolean;
  /** Durable always-surface tier — requires an embedding client to retrieve. */
  durableTier: boolean;
  /** Stored-process reuse — requires neon (only it provides processMemory) + embeddings. */
  processReuse: boolean;
  /** Human-readable degradation notes, empty when fully healthy. */
  warnings: string[];
}

/** Build the KG health snapshot from the installed-plugin registry alone. */
export function buildKgHealth(registry: InstalledRegistry): KgHealth {
  const isActive = (id: string): boolean => registry.get(id)?.status === 'active';

  const neon = isActive(KG_NEON_ID);
  const inmemory = isActive(KG_INMEMORY_ID);
  const backend: KgHealth['backend'] = neon
    ? 'neon'
    : inmemory
      ? 'inmemory'
      : 'none';

  // Must match the embeddings plugin's OWN activation gate exactly: it
  // publishes the client iff `(ollama_base_url ?? '').trim()` is non-empty
  // (harness-embeddings/src/plugin.ts). A whitespace-only URL (settable via the
  // unvalidated UI config PATCH) publishes nothing, so .trim() here avoids a
  // false-healthy reading — the very lie this snapshot exists to prevent.
  const embUrl = registry.get(EMBEDDINGS_ID)?.config?.['ollama_base_url'];
  const embeddings =
    isActive(EMBEDDINGS_ID) &&
    typeof embUrl === 'string' &&
    embUrl.trim().length > 0;

  const durable = backend === 'neon';
  // Both semantic recall and the durable tier need an embedding client to query.
  const semanticRecall = backend !== 'none' && embeddings;
  const durableTier = backend !== 'none' && embeddings;
  // processMemory is provided only by the neon backend and needs embeddings to
  // write/query stored processes.
  const processReuse = backend === 'neon' && embeddings;

  const warnings: string[] = [];
  if (backend === 'none') {
    warnings.push('no knowledge-graph backend active — recall is unavailable');
  }
  if (backend === 'inmemory') {
    warnings.push(
      'inmemory KG backend: state is lost on restart (set DATABASE_URL + install the neon backend for durability)',
    );
  }
  if (backend !== 'none' && !embeddings) {
    warnings.push(
      'embeddings disabled: semantic recall, the durable tier and process-reuse are all inactive (FTS-only) — set OLLAMA_BASE_URL / enable the embeddings overlay',
    );
  }
  if (backend === 'inmemory' && embeddings) {
    warnings.push(
      'process-reuse unavailable on the inmemory backend (only neon provides processMemory)',
    );
  }

  return {
    backend,
    durable,
    embeddings,
    semanticRecall,
    durableTier,
    processReuse,
    warnings,
  };
}
