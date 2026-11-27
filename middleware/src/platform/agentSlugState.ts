// Slug-keyed state of a deleted agent (#1881, ADR-0218).
//
// Several stores key an agent's data by its slug, not by its id. A delete
// keeps a tombstone (#2088) and frees the slug, so without this module a new
// agent with the same slug inherits the old one's memory, its public MCP key
// bindings and its graph history.
//
// On delete (`retire`):
//   - the memory trees `/memories/orchestrators/<slug>` and
//     `/memories/contexts/<slug>` MOVE under the tombstone's placeholder slug
//     (`deleted-<id>`). They stay purgeable through the Danger-Zone purge
//     (ADR-0120, axis `agent`, selector = the placeholder slug): previewed,
//     audited, complete. Discretion labels move with the notes when the
//     caller hands a labelling wrapper (`labelMoves`);
//   - the public MCP key bindings of the slug are REMOVED: a binding has no
//     value without its agent, and one left behind would reach the tools of
//     the next agent with that slug.
//
// The graph cannot be moved: the external ids of turns, sessions, runs and
// tool calls embed the scope `<slug>::…`. So on create (`remaining`) the
// kernel refuses a slug while state is still keyed by it — graph history,
// curated memory (`origin_agent`), a memory tree a failed or older delete
// left, a binding. The operator purges it first (Danger Zone, axis `agent`,
// selector = the slug).
//
// `retire` never throws: a part that fails is in the report, and the create
// check catches what it left behind.

import type { KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import type { PublicMcpKeyBindingAdminStore } from '../mcp/publicMcpKeyBindingsAdmin.js';

const MEMORIES_ROOT = '/memories';

/** The per-agent top-level trees, both keyed `<root>/<slug>`. */
export const AGENT_MEMORY_ROOTS = [
  `${MEMORIES_ROOT}/orchestrators`,
  `${MEMORIES_ROOT}/contexts`,
] as const;

/** Bound on what a report lists, since it goes into the audit. */
const MAX_LISTED = 50;

export interface AgentSlugStateDeps {
  /** The ROOT memory store (undecorated). Absent = no memory to move. */
  readonly memoryStore?: () => MemoryStore | undefined;
  /**
   * Wrap the root store for a move, so discretion labels go to the new paths
   * (`LabelledMemoryStore`, #2079). Absent = the raw store moves the notes.
   */
  readonly labelMoves?: (store: MemoryStore, agentSlug: string) => MemoryStore;
  /** Absent = no database for bindings. */
  readonly mcpBindings?: () => Pick<PublicMcpKeyBindingAdminStore, 'list' | 'remove'> | undefined;
  /** The RAW graph (kernel-only counts). Absent = no graph to check. */
  readonly knowledgeGraph?: () =>
    | Pick<KnowledgeGraph, 'countMemorableKnowledge' | 'countConversationHistory'>
    | undefined;
  readonly tenantId: string;
  readonly log?: (message: string) => void;
}

export interface SlugStateFailure {
  readonly part: 'memory' | 'mcp_bindings';
  readonly detail: string;
}

/** What a delete did with the slug's state. */
export interface SlugStateRetirement {
  readonly fromSlug: string;
  readonly toSlug: string;
  /** Memory trees moved, as `<from> -> <to>`. */
  readonly memoryMoved: readonly string[];
  /** Key ids whose binding was removed. */
  readonly mcpBindingsRemoved: readonly string[];
  readonly failures: readonly SlugStateFailure[];
}

/** State still keyed by a slug. Empty = the slug is free to reuse. */
export interface RemainingSlugState {
  readonly memoryTrees: readonly string[];
  readonly mcpBindings: readonly string[];
  /** Conversation-history nodes in the scopes `<slug>::…`. */
  readonly graphHistory: number;
  /** Curated memory (`MemorableKnowledge`) with `origin_agent = <slug>`. */
  readonly memorableKnowledge: number;
}

export interface AgentSlugState {
  /** Move or remove the state of a deleted agent's slug. Never throws. */
  retire(fromSlug: string, toSlug: string): Promise<SlugStateRetirement>;
  /** What is still keyed by `slug`. Throws when a store cannot answer. */
  remaining(slug: string): Promise<RemainingSlugState>;
}

export function hasRemainingSlugState(state: RemainingSlugState): boolean {
  return (
    state.memoryTrees.length > 0 ||
    state.mcpBindings.length > 0 ||
    state.graphHistory > 0 ||
    state.memorableKnowledge > 0
  );
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

async function existingTrees(store: MemoryStore, slug: string): Promise<string[]> {
  const trees: string[] = [];
  for (const root of AGENT_MEMORY_ROOTS) {
    const tree = `${root}/${slug}`;
    if (await store.directoryExists(tree)) trees.push(tree);
  }
  return trees;
}

export function createAgentSlugState(deps: AgentSlugStateDeps): AgentSlugState {
  const log = deps.log ?? (() => undefined);

  async function moveMemory(
    fromSlug: string,
    toSlug: string,
  ): Promise<{ moved: string[]; failures: SlugStateFailure[] }> {
    const root = deps.memoryStore?.();
    if (!root) return { moved: [], failures: [] };
    const mover = deps.labelMoves ? deps.labelMoves(root, toSlug) : root;
    const moved: string[] = [];
    const failures: SlugStateFailure[] = [];
    for (const base of AGENT_MEMORY_ROOTS) {
      const from = `${base}/${fromSlug}`;
      const to = `${base}/${toSlug}`;
      try {
        if (!(await root.directoryExists(from))) continue;
        await mover.rename(from, to);
        moved.push(`${from} -> ${to}`);
      } catch (err) {
        const detail = `${from}: ${message(err)}`;
        log(`[agent-slug-state] moving the memory of '${fromSlug}' failed: ${detail}`);
        failures.push({ part: 'memory', detail });
      }
    }
    return { moved, failures };
  }

  async function removeBindings(slug: string): Promise<{ removed: string[]; failures: SlugStateFailure[] }> {
    const store = deps.mcpBindings?.();
    if (!store) return { removed: [], failures: [] };
    const removed: string[] = [];
    try {
      const bound = (await store.list()).filter((row) => row.agentId === slug);
      for (const row of bound) {
        if (await store.remove(row.keyId)) removed.push(row.keyId);
      }
      return { removed, failures: [] };
    } catch (err) {
      const detail = message(err);
      log(`[agent-slug-state] removing the MCP key bindings of '${slug}' failed: ${detail}`);
      return { removed, failures: [{ part: 'mcp_bindings', detail }] };
    }
  }

  async function graphCounts(slug: string): Promise<Pick<RemainingSlugState, 'graphHistory' | 'memorableKnowledge'>> {
    const graph = deps.knowledgeGraph?.();
    if (!graph) return { graphHistory: 0, memorableKnowledge: 0 };
    const [mk, history] = await Promise.all([
      graph.countMemorableKnowledge({ tenantId: deps.tenantId, originAgent: slug }),
      graph.countConversationHistory
        ? graph.countConversationHistory({ tenantId: deps.tenantId, agentSlug: slug })
        : Promise.resolve({ count: 0 }),
    ]);
    return { graphHistory: history.count, memorableKnowledge: mk.count };
  }

  return {
    async retire(fromSlug, toSlug) {
      const memory = await moveMemory(fromSlug, toSlug);
      const bindings = await removeBindings(fromSlug);
      return {
        fromSlug,
        toSlug,
        memoryMoved: memory.moved,
        mcpBindingsRemoved: bindings.removed.slice(0, MAX_LISTED),
        failures: [...memory.failures, ...bindings.failures],
      };
    },

    async remaining(slug) {
      const store = deps.memoryStore?.();
      const bindings = deps.mcpBindings?.();
      const [memoryTrees, bound, graph] = await Promise.all([
        store ? existingTrees(store, slug) : Promise.resolve([]),
        bindings ? bindings.list() : Promise.resolve([]),
        graphCounts(slug),
      ]);
      return {
        memoryTrees,
        mcpBindings: bound
          .filter((row) => row.agentId === slug)
          .map((row) => row.keyId)
          .slice(0, MAX_LISTED),
        ...graph,
      };
    },
  };
}
