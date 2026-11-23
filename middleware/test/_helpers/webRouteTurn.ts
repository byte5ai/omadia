/**
 * #2055 — a `routeTurn` for `createChatRouter` tests that do not need the
 * real management layer: an explicit slug, else the default slug, served from
 * a lookup. Mirrors the real outcome shapes: an unknown explicit slug yields
 * `agent_unknown`, no slug and no default yields `no_agent` — both answered by
 * `system`, never by another agent.
 */
import { buildSystemNotice, type ChatAgent } from '@omadia/orchestrator';

import type { WebRouteRequest, WebRouteResult } from '../../src/routes/chat.js';

export function routeTurnFrom(
  lookup: (slug: string) => ChatAgent | undefined,
  defaultSlug: () => string | undefined = () => undefined,
  onRequest?: (request: WebRouteRequest) => void,
): (request: WebRouteRequest) => WebRouteResult {
  return (request) => {
    onRequest?.(request);
    const slug = request.explicitSlug ?? defaultSlug();
    if (slug === undefined) {
      return { kind: 'notice', notice: buildSystemNotice('no_agent', { locale: 'en' }) };
    }
    const chatAgent = lookup(slug);
    if (!chatAgent) {
      return {
        kind: 'notice',
        notice: buildSystemNotice('agent_unknown', {
          agent: { slug, displayName: slug },
          locale: 'en',
        }),
      };
    }
    return {
      kind: 'agent',
      chatAgent,
      slug,
      speaker: { kind: 'agent', agentId: `id-${slug}`, slug, displayName: slug },
    };
  };
}
