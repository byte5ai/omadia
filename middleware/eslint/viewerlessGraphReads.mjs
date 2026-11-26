/**
 * Memory-ACL plan, step 4b — knowledge-graph reads that take no viewer.
 *
 * These `KnowledgeGraph` methods return memory without asking whose turn it
 * is (`packages/plugin-api/src/knowledgeGraph.ts`): filtering is the
 * caller's job. Every side door found so far (#1825, #2204, #2208) was a new
 * caller that forgot. Lint fails on a new call outside ALLOWLIST; read with
 * the viewer instead (`getSession(scope, { userId | audienceOwners })`,
 * `getMemorableKnowledge(id, viewer)`, `visibleNeighbors`, the bounded graph
 * services), or add the file here with the reason its reads cannot reach
 * someone who may not see them. `test/memoryAccess/viewerlessGraphReads.test.ts`
 * fails when an entry no longer calls one of them.
 *
 * Wired into `eslint.config.mjs` as `no-restricted-syntax`. A later config
 * block that sets `no-restricted-syntax` for the same files replaces these
 * selectors; add selectors to this list instead.
 */

const ANY_ARITY = [
  'listSessions',
  'getNeighbors',
  'getNeighborsOfType',
  'listMemoriesForScope',
  'listTopics',
  'listTopicMembers',
  'listTopicMembershipEdges',
  'listAllIssues',
  'listMemorableKnowledgeWithEmbeddings',
  'getMemorableKnowledgeSubgraph',
  'listOwnerlessMemorableKnowledge',
];

/** Viewer-less only without their second argument (the viewer or read options). */
const ONE_ARGUMENT = ['getSession', 'getMemorableKnowledge'];

const MESSAGE =
  'Viewer-less knowledge-graph read: it returns memory without checking who may see it. Pass the viewer, or add the file with a reason to eslint/viewerlessGraphReads.mjs (memory-ACL plan, step 4b).';

export const VIEWERLESS_GRAPH_READ_SELECTORS = [
  {
    selector: `CallExpression[callee.property.name=/^(${ANY_ARITY.join('|')})$/]`,
    message: MESSAGE,
  },
  {
    selector: `CallExpression[callee.property.name=/^(${ONE_ARGUMENT.join('|')})$/][arguments.length<2]`,
    message: MESSAGE,
  },
];

/** File (relative to middleware/) → why its viewer-less reads are safe. */
export const VIEWERLESS_GRAPH_READ_ALLOWLIST = {
  // The graph itself and its contract.
  'packages/harness-knowledge-graph-inmemory/src/inMemoryKnowledgeGraph.ts':
    'the backend: getNeighborsOfType built on its own getNeighbors',
  'packages/plugin-api/src/knowledgeGraph.ts':
    'neighborsOfType(): the batched-read fallback; callers filter its result like getNeighbors',

  // Decorators that forward the caller's arguments unchanged.
  'packages/harness-orchestrator-extras/src/captureFilteringKnowledgeGraph.ts':
    'pass-through decorator: forwards each read with the arguments it was given',
  'packages/harness-orchestrator-extras/src/inconsistencyTriggeringKnowledgeGraph.ts':
    'pass-through decorator: forwards each read with the arguments it was given',
  'packages/harness-orchestrator-extras/src/mergeTriggeringKnowledgeGraph.ts':
    'pass-through decorator: forwards each read with the arguments it was given',

  // The viewer filters.
  'packages/harness-orchestrator/src/graphNodeAccess.ts':
    'the graph-walk viewer filter itself (#1825, #2208): neighbours pass `visible` before anyone sees them',
  'src/platform/shieldedNeighbors.ts':
    'Privacy Shield check: reads a node\'s turns to decide whether it is protected, returns no neighbour',
  'src/platform/boundedGraphServices.ts':
    'ADR-0044 plugin bound: reads a step\'s plan only to check it is in the plugin\'s own scope before a write',
  'packages/harness-orchestrator/src/knowledgeGraphTool.ts':
    'query_knowledge_graph: restricted views read through graphViewAccess; the view-less branch is a turn without a graph boundary (canary sweep, off mode)',

  // Turn paths whose result is filtered or bounded by the caller.
  'packages/harness-orchestrator-extras/src/contextRetriever.ts':
    'entities next to turns recall already admitted for this viewer; only entity node types are kept',
  'packages/harness-orchestrator-extras/src/kgWalkPayload.ts':
    'the orchestrator passes every payload through boundToViewer before the client sees it (#1825)',
  'packages/harness-orchestrator-extras/src/sessionBriefing.ts':
    'the orchestrator calls it with this agent\'s own conversation scope and never in members mode',
  'packages/harness-orchestrator-extras/src/topicClustering.ts':
    'list/getWithMembers gate every member with the viewer (#1851); re-clustering is an operator job',

  // Background jobs whose results reach people only through viewer-gated routes.
  'packages/harness-orchestrator-extras/src/bulkInconsistency.ts':
    'operator sweep: re-reads a marker; findings surface through /admin/inconsistencies, gated per viewer',
  'packages/harness-orchestrator-extras/src/bulkMergeDetect.ts':
    'operator sweep: re-reads a marker; findings surface through /admin/duplicates, gated per viewer',
  'packages/harness-orchestrator-extras/src/inconsistencyDetector.ts':
    'background detector: compares memories; findings surface through /admin/inconsistencies, gated per viewer',
  'packages/harness-orchestrator-extras/src/mergeCandidateDetector.ts':
    'background detector: compares memories; findings surface through /admin/duplicates, gated per viewer',

  // Routes.
  'src/routes/duplicates.ts':
    'finds an excerpt\'s parent, then reads it with getMemorableKnowledge(parent, viewer)',
  'src/routes/memoryOwnerless.ts':
    'operator-only route (every account is an operator) listing knowledge nobody owns',
  'src/routes/devGraph.ts':
    'dev-only, behind DEV_ENDPOINTS_ENABLED; no production guard yet (#2275)',
};
