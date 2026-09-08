/**
 * Read-only discovery over the OpenAI-compatible `GET /v1/models` endpoint,
 * which every provider this adapter serves exposes (OpenAI, Mistral, MiniMax,
 * Ollama, vLLM, Azure OpenAI). The SDK's `client.models.list()` auto-paginates
 * and tolerates the vendor-specific extras we read here:
 *
 *  - `created` (unix seconds, all vendors) → `createdAt`, the "newest wins"
 *    signal for default/alias selection;
 *  - `capabilities.vision` (Mistral) → `vision`;
 *  - `shutdown_date` (OpenAI) → `shutdownAt`, so retiring ids drop out;
 *  - `name` (Ollama/Mistral, when present) → `label`.
 *
 * The plain OpenAI list reports little beyond the id — context window, output
 * cap and effort support are NOT in the payload. Those come from the
 * provider's discovery rules (`ModelDiscoveryClassRule` fallbacks); this file
 * deliberately does not guess them.
 */
import type OpenAI from 'openai';

import type { DiscoveredModel } from '@omadia/llm-provider-api';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null
    ? (value as UnknownRecord)
    : undefined;
}

/** `created` is unix SECONDS on every OpenAI-compatible server seen so far;
 *  an ISO string is accepted too. Anything else → no timestamp. */
function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  return undefined;
}

/** Map one raw list entry. Returns undefined for entries without a usable id
 *  (a malformed vendor record must not poison the whole list). */
export function mapOpenAiCompatibleModel(raw: unknown): DiscoveredModel | undefined {
  const rec = asRecord(raw);
  const id = rec?.['id'];
  if (rec === undefined || typeof id !== 'string' || id.trim().length === 0) {
    return undefined;
  }
  const capabilities = asRecord(rec['capabilities']);
  const vision = capabilities?.['vision'];
  const shutdown = rec['shutdown_date'];
  const name = rec['name'];
  const createdAt = toIsoTimestamp(rec['created']);
  return {
    modelId: id.trim(),
    ...(typeof name === 'string' && name.trim().length > 0 ? { label: name.trim() } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(typeof vision === 'boolean' ? { vision } : {}),
    ...(typeof shutdown === 'string' && shutdown.length > 0 ? { shutdownAt: shutdown } : {}),
  };
}

export async function listOpenAiCompatibleModels(
  client: OpenAI,
): Promise<DiscoveredModel[]> {
  const models: DiscoveredModel[] = [];
  for await (const entry of client.models.list()) {
    const mapped = mapOpenAiCompatibleModel(entry);
    if (mapped !== undefined) models.push(mapped);
  }
  return models;
}
