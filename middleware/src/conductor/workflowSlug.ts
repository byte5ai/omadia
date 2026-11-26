import { EPHEMERAL_SLUG_PREFIX } from './ephemeralRunService.js';

// Root segments owned by the operator router. Express matches them case-insensitively.
const RESERVED_SLUGS = new Set(['actions', 'agents', 'awaits', 'builder', 'discussions', 'emit', 'events', 'people', 'roles', 'templates', 'webhooks']);

export function reservedWorkflowSlugCode(slug: string): string | null {
  const normalized = slug.toLowerCase();
  if (normalized.startsWith(EPHEMERAL_SLUG_PREFIX)) return 'conductor.reserved_slug_prefix';
  if (RESERVED_SLUGS.has(normalized)) return 'conductor.reserved_slug';
  return null;
}
