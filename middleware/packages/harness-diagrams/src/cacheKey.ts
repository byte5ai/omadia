import { createHash } from 'node:crypto';
import type { DiagramKind } from './types.js';

/**
 * Build a content-addressed storage key for a rendered diagram.
 *
 * Layout: `<tenant>/<sha256(kind + "\n" + source)>.png`
 *
 * Collision-resistant across all tenants because the hash covers the kind too,
 * so Mermaid "A->B" and Graphviz "A->B" get different keys even if their
 * sources happened to hash the same. Hash is computed over UTF-8 bytes so
 * non-ASCII labels are fine.
 */
export function buildCacheKey(params: {
  kind: DiagramKind;
  source: string;
  tenantId: string;
}): string {
  const digest = createHash('sha256')
    .update(params.kind)
    .update('\n')
    .update(params.source, 'utf8')
    .digest('hex');
  // Tenant segment is encoded to keep the key URL-safe even if a future
  // tenant id contains slashes or other reserved chars.
  return `${encodeURIComponent(params.tenantId)}/${digest}.png`;
}
