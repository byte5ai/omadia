import type { PluginContext } from '@omadia/plugin-api';
import { EntityRefBus } from '@omadia/plugin-api';

import { InMemoryKnowledgeGraph } from './inMemoryKnowledgeGraph.js';

/**
 * @omadia/knowledge-graph-inmemory — plugin entry point.
 *
 * `kind: extension`. Provides on activate():
 *   - `knowledgeGraph` — in-memory entity store (process RAM, lost on restart).
 *   - `entityRefBus`   — ephemeral per-Turn in-memory pub/sub for EntityRef
 *     observations. New EntityRefBus instance per process — orthogonal to
 *     the storage backend (Fork-Decision #2).
 *
 * Pulls from kernel bridges:
 *   - `turnContext` — kernel-side AsyncLocalStorage accessor used to bind
 *     the EntityRefBus's `getCurrentTurnId` getter so per-turn correlation
 *     is preserved. Optional — without it, refs published outside a
 *     `beginCollection` window are dropped (acceptable for in-memory).
 *
 * S+11-2b: capability ownership flipped here from the legacy
 * @omadia/knowledge-graph plugin. Mutual exclusion with the
 * `*-neon` sibling — both plugins declare `provides: knowledgeGraph@1`,
 * the operator picks one (RequiresWizard / install UI), `ctx.services.provide`
 * throws on a duplicate so two-active is structurally impossible.
 */

const KNOWLEDGE_GRAPH_SERVICE = 'knowledgeGraph';
const ENTITY_REF_BUS_SERVICE = 'entityRefBus';
const TURN_CONTEXT_SERVICE = 'turnContext';

/** Kernel-side AsyncLocalStorage accessor (structural type — published by the
 *  middleware kernel via ServiceRegistry). Inlined locally because the type
 *  is trivial and lifting it to plugin-api would be cross-cutting churn. */
interface TurnContextAccessor {
  currentTurnId(): string | undefined;
}

export interface InMemoryKnowledgeGraphPluginHandle {
  close(): Promise<void>;
}

export async function activate(
  ctx: PluginContext,
): Promise<InMemoryKnowledgeGraphPluginHandle> {
  ctx.log('[harness-knowledge-graph-inmemory] activating');

  const turnContextAccessor = ctx.services.get<TurnContextAccessor>(TURN_CONTEXT_SERVICE);

  const knowledgeGraph = new InMemoryKnowledgeGraph();
  const entityRefBus = new EntityRefBus({
    getCurrentTurnId: () => turnContextAccessor?.currentTurnId(),
  });

  const disposeGraph = ctx.services.provide(KNOWLEDGE_GRAPH_SERVICE, knowledgeGraph);
  const disposeBus = ctx.services.provide(ENTITY_REF_BUS_SERVICE, entityRefBus);

  ctx.log(
    '[harness-knowledge-graph-inmemory] ready (backend=in-memory, embeddings=off — no persistence, dev/test only)',
  );

  return {
    async close(): Promise<void> {
      ctx.log('[harness-knowledge-graph-inmemory] deactivating');
      disposeBus();
      disposeGraph();
    },
  };
}
