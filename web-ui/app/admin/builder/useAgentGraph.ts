'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../../_lib/api';
import { getAgentGraph, type AgentGraph } from '../../_lib/agentBuilder';

export type GraphState =
  | { kind: 'loading' }
  | { kind: 'ready'; graph: AgentGraph }
  | { kind: 'error'; message: string };

export interface UseAgentGraph {
  state: GraphState;
  /** Last transient action error (optimistic rollback surfaced this). */
  actionError: string | null;
  clearActionError: () => void;
  /** Re-fetch the whole graph from the backend. */
  reload: () => Promise<void>;
  /**
   * Optimistic mutation helper. Applies `optimistic` to the local graph
   * immediately, runs `commit` against the backend, and rolls back to the
   * pre-mutation snapshot if `commit` throws. `commit` may return a fresh
   * graph to reconcile with the authoritative server state.
   */
  mutate: (
    optimistic: (g: AgentGraph) => AgentGraph,
    commit: (g: AgentGraph) => Promise<AgentGraph | void>,
  ) => Promise<void>;
}

function friendlyError(err: unknown): string {
  if (err instanceof ApiError) return `Fehler ${err.status}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Loads and mutates an agent's canvas graph with optimistic UI + rollback.
 * The single `mutate` primitive backs every edge/node operation in the
 * canvas: snapshot → apply → commit → (rollback on failure).
 */
export function useAgentGraph(slug: string | null): UseAgentGraph {
  const [state, setState] = useState<GraphState>(
    slug ? { kind: 'loading' } : { kind: 'error', message: '' },
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const stateRef = useRef<GraphState>(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const reload = useCallback(async (): Promise<void> => {
    if (!slug) return;
    setState({ kind: 'loading' });
    try {
      const graph = await getAgentGraph(slug);
      setState({ kind: 'ready', graph });
    } catch (err) {
      setState({ kind: 'error', message: friendlyError(err) });
    }
  }, [slug]);

  useEffect(() => {
    if (!slug) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [slug, reload]);

  const mutate = useCallback<UseAgentGraph['mutate']>(
    async (optimistic, commit) => {
      const current = stateRef.current;
      if (current.kind !== 'ready') return;
      const snapshot = current.graph;
      const next = optimistic(snapshot);
      setActionError(null);
      setState({ kind: 'ready', graph: next });
      try {
        const reconciled = await commit(next);
        if (reconciled) setState({ kind: 'ready', graph: reconciled });
      } catch (err) {
        // Rollback to the authoritative pre-mutation snapshot.
        setState({ kind: 'ready', graph: snapshot });
        setActionError(friendlyError(err));
      }
    },
    [],
  );

  return {
    state,
    actionError,
    clearActionError: useCallback(() => setActionError(null), []),
    reload,
    mutate,
  };
}
