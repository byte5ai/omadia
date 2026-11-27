// Memory-ACL plan step 6a — the hand-written mutation catalog. One entry per
// ACL predicate: `find` is removed or forced open. `set`: which suites run
// (mem = in-memory memoryAccess files, pg = the Neon ones, both = mem then pg).
const IM = 'packages/harness-knowledge-graph-inmemory/src/inMemoryKnowledgeGraph.ts';
const NEON = 'packages/harness-knowledge-graph-neon/src/neonKnowledgeGraph.ts';
const VIEW = 'packages/harness-orchestrator/src/graphNodeAccess.ts';
const SCOPED = 'packages/harness-orchestrator/src/registry/scopedMemoryStore.ts';
const NS = 'packages/harness-orchestrator/src/orchestratorMemoryNamespacer.ts';
const MEMBERS = 'packages/harness-orchestrator/src/membersMemory.ts';
const BOUND = 'src/platform/boundedGraphServices.ts';
const RETR = 'packages/harness-orchestrator-extras/src/contextRetriever.ts';
const MK = 'async searchMemorableKnowledgeByEmbedding(';
const EX = 'async searchExcerptsByEmbedding(';

export const MUTANTS = [
  // ── In-memory graph: memorable knowledge + excerpt search ─────────────
  { id: 'IM01', layer: 'in-memory graph', what: 'memory search: owner check dropped', file: IM, after: MK, find: 'owners.includes(opts.viewerOmadiaUserId) && agentMatch;', replace: 'agentMatch;' },
  { id: 'IM02', layer: 'in-memory graph', what: 'excerpt search: owner check dropped', file: IM, after: EX, find: 'owners.includes(opts.viewerOmadiaUserId) && agentMatch;', replace: 'agentMatch;' },
  { id: 'IM03', layer: 'in-memory graph', what: 'memory search: origin-agent isolation dropped', file: IM, after: MK, find: 'opts.viewerAgentSlug === undefined ||', replace: 'true ||' },
  { id: 'IM04', layer: 'in-memory graph', what: 'excerpt search: origin-agent isolation dropped', file: IM, after: EX, find: 'opts.viewerAgentSlug === undefined ||', replace: 'true ||' },
  { id: 'IM05', layer: 'in-memory graph', what: 'memory search: team branch on without teamVisibility', file: IM, after: MK, find: "(opts.teamVisibility === true || opts.sharedOnly === true) &&\n        ['team', 'public'].includes(node.visibility ?? 'team');", replace: "['team', 'public'].includes(node.visibility ?? 'team');" },
  { id: 'IM06', layer: 'in-memory graph', what: 'memory search: team branch admits private rows', file: IM, after: MK, find: "(opts.teamVisibility === true || opts.sharedOnly === true) &&\n        ['team', 'public'].includes(node.visibility ?? 'team');", replace: '(opts.teamVisibility === true || opts.sharedOnly === true);' },
  { id: 'IM07', layer: 'in-memory graph', what: 'excerpt search: team branch on without teamVisibility', file: IM, after: EX, find: "(opts.teamVisibility === true || opts.sharedOnly === true) &&\n        ['team', 'public'].includes(parent.visibility ?? 'team');", replace: "['team', 'public'].includes(parent.visibility ?? 'team');" },
  { id: 'IM08', layer: 'in-memory graph', what: 'memory search: sharedOnly narrowing dropped', file: IM, after: MK, find: "opts.sharedOnly !== true || ['team', 'public'].includes(node.visibility ?? 'team');", replace: 'true;' },
  { id: 'IM09', layer: 'in-memory graph', what: 'memory search: members room rule ignores the audience', file: IM, after: MK, find: '(ownersCoverAudience(owners, canonicalOwners(opts.audienceOwners)) ||\n              isOperatorAuthored(node)) &&', replace: '' },
  { id: 'IM10', layer: 'in-memory graph', what: 'members: auto-promoted durable rows count as operator-authored', file: IM, find: "return node.manuallyAuthored === true && !String(node.props['created_by'] ?? '').startsWith('auto:');", replace: 'return node.manuallyAuthored === true;' },
  { id: 'IM11', layer: 'in-memory graph', what: 'memory search: members room rule drops origin-agent isolation', file: IM, after: MK, find: 'isOperatorAuthored(node)) &&\n            agentMatch', replace: 'isOperatorAuthored(node))' },
  { id: 'IM12', layer: 'in-memory graph', what: 'memory search: Privacy Shield skip dropped', file: IM, find: 'if (opts.excludeUnprotected === true && !this.isProtectedMemory(node)) continue;', replace: '' },
  { id: 'IM13', layer: 'in-memory graph', what: 'excerpt search: Privacy Shield skip dropped', file: IM, find: 'if (opts.excludeUnprotected === true && !this.isProtectedMemory(parent)) continue;', replace: '' },
  { id: 'IM14', layer: 'in-memory graph', what: 'shield: DERIVED_FROM unprotected-turn check dropped', file: IM, find: "if (turn?.type === 'Turn' && turn.props['unprotected'] === true) return false;", replace: '' },
  { id: 'IM15', layer: 'in-memory graph', what: 'empty audience no longer matches nothing', file: IM, find: 'return audience !== undefined && canonicalOwners(audience).length === 0;', replace: 'return false;' },
  { id: 'IM16', layer: 'in-memory graph', what: 'getMemorableKnowledge(id, viewer): owner check dropped', file: IM, find: 'if (!owners.includes(viewerOmadiaUserId)) return null;', replace: '' },
  // ── In-memory graph: turns, sessions, plans, datasets, duplicates ─────
  { id: 'IM17', layer: 'in-memory graph', what: 'turn search: user filter dropped', file: IM, after: 'async searchTurns(', find: "if (opts.userId && node.props['userId'] !== opts.userId) continue;", replace: '' },
  { id: 'IM18', layer: 'in-memory graph', what: 'turn search: members audience filter dropped', file: IM, after: 'async searchTurns(', find: 'if (opts.audienceOwners !== undefined && !visibleToAudience(node, opts.audienceOwners)) continue;', replace: '' },
  { id: 'IM19', layer: 'in-memory graph', what: 'agent scope prefix matches every scope', file: IM, find: 'if (!prefix) return true;\n  if (scope.startsWith(prefix)) return true;', replace: 'return true;' },
  { id: 'IM20', layer: 'in-memory graph', what: 'turn search: Privacy Shield skip dropped', file: IM, after: 'async searchTurns(', find: "if (opts.excludeUnprotected === true && node.props['unprotected'] === true) continue;", replace: '' },
  { id: 'IM21', layer: 'in-memory graph', what: 'embedding turn search: user filter dropped', file: IM, after: 'async searchTurnsByEmbedding(', find: "if (opts.userId && node.props['userId'] !== opts.userId) continue;", replace: '' },
  { id: 'IM22', layer: 'in-memory graph', what: 'getSession: members audience filter dropped', file: IM, find: '(audience === undefined || visibleToAudience(this.nodes.get(turnId), audience)) &&', replace: '' },
  { id: 'IM23', layer: 'in-memory graph', what: 'getSession: user filter dropped', file: IM, find: "(userId === undefined || this.nodes.get(turnId)?.props['userId'] === userId),", replace: 'true,' },
  { id: 'IM24', layer: 'in-memory graph', what: 'room owners check admits every node', file: IM, find: "return Array.isArray(owners) && ownersCoverAudience(owners as string[], canonicalOwners(audience));", replace: 'return true;' },
  { id: 'IM25', layer: 'in-memory graph', what: 'entity-captured turns: user filter dropped', file: IM, find: "if (opts.userId && turnNode.props['userId'] !== opts.userId) continue;", replace: '' },
  { id: 'IM26', layer: 'in-memory graph', what: 'recent plans: user filter dropped', file: IM, find: "plans = plans.filter((n) => n.props['userId'] === opts.userId);", replace: '' },
  { id: 'IM27', layer: 'in-memory graph', what: 'getDataset: owner check dropped', file: IM, after: 'async getDataset(', find: 'if (!d || d.ownerOmadiaUserId !== viewerOmadiaUserId) return null;', replace: 'if (!d) return null;' },
  { id: 'IM28', layer: 'in-memory graph', what: 'queryDatasetRows: owner check dropped', file: IM, after: 'async queryDatasetRows(', find: 'if (!d || d.ownerOmadiaUserId !== viewerOmadiaUserId) return null;', replace: 'if (!d) return null;' },
  { id: 'IM29', layer: 'in-memory graph', what: 'listDatasets: owner filter dropped', file: IM, find: '.filter((d) => d.ownerOmadiaUserId === opts.ownerOmadiaUserId)', replace: '' },
  { id: 'IM30', layer: 'in-memory graph', what: 'duplicate list: viewer must own one side, dropped', file: IM, after: 'hydrateMergeCandidate(node.id)', find: 'if (!ownsAtLeastOne) continue;', replace: '' },

  // ── Neon graph (SQL) ────────────────────────────────────────────────────
  { id: 'NE01', layer: 'Neon graph', set: 'pg', what: 'memory search: owner predicate forced true', file: NEON, after: MK, find: "properties->'acl_owners' @> jsonb_build_array($3::text)", replace: "(properties->'acl_owners' @> jsonb_build_array($3::text) OR TRUE)" },
  { id: 'NE02', layer: 'Neon graph', set: 'pg', what: 'excerpt search: owner predicate forced true', file: NEON, after: EX, find: "mk.properties->'acl_owners' @> jsonb_build_array($3::text)", replace: "(mk.properties->'acl_owners' @> jsonb_build_array($3::text) OR TRUE)" },
  { id: 'NE03', layer: 'Neon graph', set: 'pg', what: 'memory search: team branch on without teamVisibility', file: NEON, after: MK, find: "($5::boolean AND COALESCE(visibility, 'team') IN ('team', 'public'))", replace: "(($5::boolean OR TRUE) AND COALESCE(visibility, 'team') IN ('team', 'public'))" },
  { id: 'NE04', layer: 'Neon graph', set: 'pg', what: 'memory search: team branch admits private rows', file: NEON, after: MK, find: "($5::boolean AND COALESCE(visibility, 'team') IN ('team', 'public'))", replace: '($5::boolean)' },
  { id: 'NE05', layer: 'Neon graph', set: 'pg', what: 'memory search: origin-agent isolation (owner branch) dropped', file: NEON, after: MK, nth: 1, find: "OR properties->>'origin_agent' = $6", replace: "OR (properties->>'origin_agent' = $6 OR TRUE)" },
  { id: 'NE06', layer: 'Neon graph', set: 'pg', what: 'memory search: members room rule ignores the audience', file: NEON, after: MK, find: "AND (properties->'acl_owners' @> $9::jsonb", replace: "AND ((properties->'acl_owners' @> $9::jsonb OR TRUE)" },
  { id: 'NE07', layer: 'Neon graph', set: 'pg', what: 'memory search: sharedOnly narrowing dropped', file: NEON, after: MK, find: "AND ($8::boolean IS NOT TRUE OR COALESCE(visibility, 'team') IN ('team', 'public'))", replace: "AND (($8::boolean IS NOT TRUE OR COALESCE(visibility, 'team') IN ('team', 'public')) OR TRUE)" },
  { id: 'NE08', layer: 'Neon graph', set: 'pg', what: 'memory search: Privacy Shield skip dropped', file: NEON, after: MK, find: "AND ($10::boolean IS NOT TRUE OR (${mkProtectedSql('graph_nodes', '$2')}))", replace: "AND (($10::boolean IS NOT TRUE OR (${mkProtectedSql('graph_nodes', '$2')})) OR TRUE)" },
  { id: 'NE09', layer: 'Neon graph', set: 'pg', what: 'shield: DERIVED_FROM unprotected-turn check dropped', file: NEON, find: "AND COALESCE((src.properties->>'unprotected')::boolean, FALSE))`;", replace: 'AND FALSE)`;' },
  { id: 'NE10', layer: 'Neon graph', set: 'pg', what: 'memory search: tenant predicate dropped', file: NEON, after: MK, find: "WHERE tenant_id = $2\n        AND type = 'MemorableKnowledge'", replace: "WHERE (tenant_id = $2 OR TRUE)\n        AND type = 'MemorableKnowledge'" },
  { id: 'NE11', layer: 'Neon graph', set: 'pg', what: 'excerpt search: tenant predicates dropped', file: NEON, edits: [
    { after: EX, find: 'WHERE ex.tenant_id = $2', replace: "WHERE (ex.tenant_id = $2 OR TRUE)" },
    { after: EX, find: 'AND mk.tenant_id = $2', replace: "AND (mk.tenant_id = $2 OR TRUE)" },
  ] },
  { id: 'NE12', layer: 'Neon graph', set: 'pg', what: 'excerpt search: team branch on without teamVisibility', file: NEON, after: EX, find: "($5::boolean AND COALESCE(mk.visibility, 'team') IN ('team', 'public'))", replace: "(($5::boolean OR TRUE) AND COALESCE(mk.visibility, 'team') IN ('team', 'public'))" },
  { id: 'NE13', layer: 'Neon graph', set: 'pg', what: 'excerpt search: members room rule ignores the audience', file: NEON, after: EX, find: "AND (mk.properties->'acl_owners' @> $8::jsonb", replace: "AND ((mk.properties->'acl_owners' @> $8::jsonb OR TRUE)" },
  { id: 'NE14', layer: 'Neon graph', set: 'pg', what: 'excerpt search: Privacy Shield skip dropped', file: NEON, after: EX, find: "AND ($9::boolean IS NOT TRUE OR (${mkProtectedSql('mk', '$2')}))", replace: "AND (($9::boolean IS NOT TRUE OR (${mkProtectedSql('mk', '$2')})) OR TRUE)" },
  { id: 'NE15', layer: 'Neon graph', set: 'pg', what: 'getMemorableKnowledge(id, viewer): owner check dropped', file: NEON, after: 'async getMemorableKnowledge(', find: "OR properties->'acl_owners' @> jsonb_build_array($3::text)", replace: "OR (properties->'acl_owners' @> jsonb_build_array($3::text) OR TRUE)" },
  { id: 'NE16', layer: 'Neon graph', set: 'pg', what: 'hybrid turn search: user filter dropped', file: NEON, after: "coalesce(properties->>'assistantAnswer','')\n                ),\n                to_tsquery('simple', $6)", find: 'AND ($3::text IS NULL OR user_id = $3)', replace: "AND ($3::text IS NULL OR user_id = $3 OR TRUE)" },
  { id: 'NE17', layer: 'Neon graph', set: 'pg', what: 'hybrid turn search: members audience dropped', file: NEON, after: "coalesce(properties->>'assistantAnswer','')\n                ),\n                to_tsquery('simple', $6)", find: "AND ($15::jsonb IS NULL OR properties @> jsonb_build_object('owners', $15::jsonb))", replace: "AND ($15::jsonb IS NULL OR properties @> jsonb_build_object('owners', $15::jsonb) OR TRUE)" },
  { id: 'NE18', layer: 'Neon graph', set: 'pg', what: 'hybrid turn search: agent prefix dropped', file: NEON, after: "coalesce(properties->>'assistantAnswer','')\n                ),\n                to_tsquery('simple', $6)", find: 'AND ($14::text IS NULL\n            OR scope LIKE $14', replace: "AND ($14::text IS NULL OR TRUE\n            OR scope LIKE $14" },
  { id: 'NE19', layer: 'Neon graph', set: 'pg', what: 'getDataset: owner check dropped', file: NEON, after: 'async getDataset(', find: 'if (!row || row.owner_omadia_user_id !== viewerOmadiaUserId) return null;', replace: 'if (!row) return null;' },

  // ── Turn graph view (#2204): what the graph tool may show ──────────────
  { id: 'GV01', layer: 'graph view', set: 'both', what: 'user turn: memory owner check dropped', file: VIEW, find: '(agentOk && owners.some((o) => viewer.viewerIds.includes(o))) ||', replace: 'agentOk ||' },
  { id: 'GV02', layer: 'graph view', set: 'both', what: 'user turn: memory origin-agent check dropped', file: VIEW, find: '(agentOk && owners.some(', replace: '(owners.some(' },
  { id: 'GV03', layer: 'graph view', set: 'both', what: 'team-visible memory shown without teamVisibility', file: VIEW, find: '(viewer.teamVisibility === true && shared)', replace: 'shared' },
  { id: 'GV04', layer: 'graph view', set: 'both', what: 'conversation turn: every memory visible', file: VIEW, find: "case 'conversation':\n        return shared;", replace: "case 'conversation':\n        return true;" },
  { id: 'GV05', layer: 'graph view', set: 'both', what: 'members turn: room owners check dropped', file: VIEW, find: 'return ownersCoverAudience(owners, canonicalOwners(bound.audience)) || operator;', replace: 'return true;' },
  { id: 'GV06', layer: 'graph view', set: 'both', what: 'shielded turn: unprotected turns shown', file: VIEW, find: "if (viewer.shielded === true && node.props['unprotected'] === true) return false;", replace: '' },
  { id: 'GV07', layer: 'graph view', set: 'both', what: 'turn visible without being in a readable session', file: VIEW, find: 'return (await visibleTurns(scope))?.has(node.id) ?? false;', replace: 'return true;' },
  { id: 'GV08', layer: 'graph view', set: 'both', what: 'entity visible without a visible capturing turn', file: VIEW, find: "for (const t of await neighborsOfType(node, 'Turn')) if (await turnVisible(t)) return true;\n        return false;", replace: 'return true;' },
  { id: 'GV09', layer: 'graph view', set: 'both', what: "another person's User node visible", file: VIEW, find: 'return viewer.viewerIds.some((id) => userNodeId(id) === node.id);', replace: 'return true;' },
  { id: 'GV10', layer: 'graph view', set: 'both', what: 'fact visible when one source turn is hidden', file: VIEW, find: 'for (const t of turns) if (!(await turnVisible(t))) return false;', replace: '' },

  // ── /memories: scope store, namespacer, binder ─────────────────────────
  { id: 'MS01', layer: '/memories scope', set: 'both', what: 'scoped store: every read allowed', file: SCOPED, find: 'for (const p of this.patterns) if (p.match(virtualPath)) return true;\n    return false;', replace: 'return true;' },
  { id: 'MS02', layer: '/memories scope', set: 'both', what: 'scoped store: ro: veto on writes dropped', file: SCOPED, find: 'if (p.readOnly) return false;', replace: '' },
  { id: 'MS03', layer: '/memories scope', set: 'both', what: 'enforce-strict reads the transcript trees (core, not core-notes)', file: SCOPED, find: "? ['ro:core-notes', ...patterns]", replace: "? ['ro:core', ...patterns]" },
  { id: 'MS04', layer: '/memories scope', set: 'both', what: 'enforce: shared trees writable', file: SCOPED, find: ": ['ro:core', `ro:orchestrator:${agentSlug}:*`, ...patterns];", replace: ": ['core', `ro:orchestrator:${agentSlug}:*`, ...patterns];" },
  { id: 'MS05', layer: '/memories scope', set: 'both', what: 'namespacer: every path passes through to the shared namespace', file: NS, find: "return seg.startsWith('_') || SHARED_SEGMENTS.has(seg);", replace: 'return true;' },
  { id: 'MS06', layer: '/memories scope', set: 'both', what: 'members index: groups not covering the room are readable', file: MEMBERS, find: 'if (wanted.every((id) => owners.has(id))) out.push(entry);', replace: 'out.push(entry);' },

  // ── Plugin boundary (ADR-0044) ─────────────────────────────────────────
  { id: 'PB01', layer: 'plugin boundary', set: 'both', what: 'plugin memory store reads private trees', file: BOUND, find: "if (PRIVATE_TREES.has(lower)) return 'none';", replace: "if (PRIVATE_TREES.has(lower)) return 'read';" },
  { id: 'PB02', layer: 'plugin boundary', set: 'both', what: 'plugin turn search: user filter dropped', file: BOUND, find: 'options: { ...options, agentScopePrefix: bound.agentScopePrefix, userId: bound.userId },', replace: 'options: { ...options, agentScopePrefix: bound.agentScopePrefix },' },
  { id: 'PB03', layer: 'plugin boundary', set: 'both', what: 'plugin turn search: room audience dropped', file: BOUND, find: 'options: { ...options, agentScopePrefix: bound.agentScopePrefix, audienceOwners: bound.audience },', replace: 'options: { ...options, agentScopePrefix: bound.agentScopePrefix },' },
  { id: 'PB04', layer: 'plugin boundary', set: 'both', what: 'plugin turn search: conversation scope not enforced', file: BOUND, find: 'scopeAllowed: (scope) => scope === only };', replace: 'scopeAllowed: () => true };' },

  // ── REST routes ─────────────────────────────────────────────────────────
  { id: 'RT01', layer: 'REST routes', what: 'GET /api/v1/memory/:id reads without the viewer', file: 'src/routes/memory.ts', nth: 0, find: 'deps.graph.getMemorableKnowledge(id, sessionUserId)', replace: 'deps.graph.getMemorableKnowledge(id)' },
  { id: 'RT02', layer: 'REST routes', what: 'chat session read: owner check dropped', file: 'src/routes/chatSessions.ts', find: 'return chatSessionOwnedBy(session, chatViewer(req), await legacyOwner()) ? session : null;', replace: 'return session;' },
  { id: 'RT03', layer: 'REST routes', what: 'chat session list: viewer filter dropped', file: 'src/routes/chatSessions.ts', find: 'await store.list({ viewer: chatViewer(req), legacyOwner: await legacyOwner() })', replace: 'await store.list({ viewer: undefined, legacyOwner: await legacyOwner() })' },
  { id: 'RT04', layer: 'REST routes', what: 'chat turn: session ownership check dropped', file: 'src/routes/chatSessionAccess.ts', find: 'return chatSessionOwnedBy(session, chatViewer(req), await legacyOwner?.());', replace: 'return true;' },

  // ── Recall (context retriever) ──────────────────────────────────────────
  { id: 'RC01', layer: 'recall', set: 'both', what: 'memory recall leg: origin-agent isolation not passed', file: RETR, nth: 0, find: '...(input.agentSlug ? { viewerAgentSlug: input.agentSlug } : {}),', replace: '' },
  { id: 'RC02', layer: 'recall', set: 'both', what: 'excerpt recall leg: origin-agent isolation not passed', file: RETR, nth: 1, find: '...(input.agentSlug ? { viewerAgentSlug: input.agentSlug } : {}),', replace: '' },
];
