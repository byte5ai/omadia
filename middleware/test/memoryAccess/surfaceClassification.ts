/**
 * Memory-ACL plan, step 4a — every surface that could hand out memory,
 * classified by hand. `surfaceInventory.test.ts` fails when the source has a
 * route, native tool or PluginContext method that is not in this table, and
 * when an entry here no longer exists in the source.
 *
 *   no-memory      reads no memory (or only writes it); the reason says why
 *   viewer-scoped  reads memory filtered to the person asking; `covered` names
 *                  the test that proves it, and the sweep entry point when the
 *                  canary sweep (`canarySweep.ts` EntryPoint / `canaryHttp.ts`
 *                  HttpRoute) covers it
 *   operator-only  reads memory across people, reachable only by an operator
 *                  (every account is an operator today: `UserRole = 'admin'`)
 *   dev-only       reads memory across people, mounted only behind a dev flag
 *
 * Adding a surface: classify it from what its code does, not from its name.
 * A viewer-scoped entry without a test proving the filter is not done.
 * Keys are those `surfaceInventory.ts` prints.
 */

export type SurfaceKind = 'no-memory' | 'viewer-scoped' | 'operator-only' | 'dev-only';

export interface Classification {
  readonly kind: SurfaceKind;
  readonly reason: string;
  /** viewer-scoped only: the test file (relative to middleware/) and, if any, the sweep entry it uses. */
  readonly covered?: { readonly test: string; readonly entry?: string };
}

const none = (reason: string): Classification => ({ kind: 'no-memory', reason });
const operator = (reason: string): Classification => ({ kind: 'operator-only', reason });
const dev = (reason: string): Classification => ({ kind: 'dev-only', reason });
const viewer = (reason: string, test: string, entry?: string): Classification => ({
  kind: 'viewer-scoped',
  reason,
  covered: entry === undefined ? { test } : { test, entry },
});

const HTTP_SWEEP = 'test/memoryAccess/canaryHttp.test.ts';
const TURN_SWEEP = 'test/memoryAccess/canarySweepSuite.ts';
const INFRA = 'middleware or mount plumbing: carries requests, serves no data of its own';

export const ROUTES: Readonly<Record<string, Classification>> = {
  // Plugin routes.
  'packages/harness-diagrams/src/plugin.ts PLUGIN DIAGRAM_LINK_ROUTE_PREFIX': none('downloads a rendered diagram file (/diagrams/dl), not memory'),
  'packages/harness-plugin-office/src/plugin.ts PLUGIN DOCUMENT_LINK_ROUTE_PREFIX': none('downloads a generated Office file (/documents/dl), not memory'),
  'packages/harness-memory/src/plugin.ts PLUGIN DEV_MEMORY_PREFIX': dev('raw /memories browser under /api/dev, behind DEV_ENDPOINTS_ENABLED; no production guard yet (#2275)'),
  'packages/harness-memory-postgres/src/plugin.ts PLUGIN DEV_MEMORY_PREFIX': dev('raw /memories browser under /api/dev, behind DEV_ENDPOINTS_ENABLED; no production guard yet (#2275)'),
  'src/channels/coreApi.ts PLUGIN channelId': none('channel inbound webhook: starts turns, whose recall the turn sweep covers'),

  // Infrastructure in src/index.ts.
  'src/index.ts USE /api/v1/files createFileLinkRenewRouter': none('re-signs an expired Office/diagram download link (#1964, ADR-0266); reads no memory'),
  'src/index.ts USE (no path) cookieParser': none(INFRA),
  'src/index.ts USE (no path) express.json': none(INFRA),
  'src/index.ts USE (no path) createPluginRawBodyMount': none(INFRA),
  'src/index.ts USE (no path) createPublicPathMount': none('opens operator-granted plugin public paths; the plugin routes are listed separately'),
  'src/index.ts USE (no path) createConductorWebhooksInboundRouter': none('signed inbound workflow webhooks: starts runs, returns status codes only'),
  'src/index.ts USE (no path) createMcpClientMetadataRouter': none('static OAuth client metadata'),
  'src/index.ts POST route modelWork.middleware': none('wraps operator jobs in a model-work record; the routers behind it are listed separately'),
  'src/index.ts POST /api/v1/memory modelWork.middleware': none('wraps the memory write in a model-work record; /api/v1/memory is listed separately'),
  'src/index.ts PATCH /api/v1/memory/:id modelWork.middleware': none('wraps the memory write in a model-work record; /api/v1/memory is listed separately'),
  'src/index.ts PATCH /api/v1/memory/:id/excerpts/:position modelWork.middleware': none('wraps the memory write in a model-work record; /api/v1/memory is listed separately'),
  'src/index.ts GET /health (inline)': none('liveness and version'),
  'src/index.ts GET WELL_KNOWN_PATH (inline)': none('static discovery document'),
  'src/index.ts GET /api/v1/operator/provenance/public-key (inline)': none('the receipt-signing public key'),
  'src/index.ts USE /api/_harness (inline)': none('plugin UI stylesheet'),
  'src/index.ts USE /p createPluginUiStaticRouter': none('static plugin UI bundles'),
  'src/index.ts USE /api/v1/auth (inline)': none('auth plumbing'),
  'src/index.ts USE /api/v1/auth createAuthRouter': none('login and session; resolves the account\'s own identity in the graph'),
  'src/index.ts USE /api/v1/operator/mcp-oauth/callback createOptionalSession': none(INFRA),

  // Per-person memory routes.
  'src/index.ts USE /api createChatUploadsRouter': none('#2336 (ADR-0310) — stores and deletes the session user\'s own uploads to their own chat (ledger rows of that account and chat only); reads no memory'),
  'src/index.ts USE /api createChatRouter': viewer('chat turns: recall, tools and the stream bounded to the turn\'s viewer', TURN_SWEEP, 'client-stream'),
  'src/index.ts USE /api/chat createChatSessionsRouter': viewer('lists and reads only the session user\'s own chats (#1762)', HTTP_SWEEP, 'GET /api/chat/sessions'),
  'src/index.ts USE /api/v1/memory createMemoryRouter': viewer('memorable knowledge read with the session user as viewer', HTTP_SWEEP, 'GET /api/v1/memory'),
  'src/index.ts USE /api/v1/datasets createDatasetsRouter': viewer('datasets of the session user', HTTP_SWEEP, 'GET /api/v1/datasets'),
  'src/index.ts USE /api/v1/admin/topics createTopicsRouter': viewer('a topic shows only when the viewer may read every member (#1851)', HTTP_SWEEP, 'GET /api/v1/admin/topics'),
  'src/index.ts USE /api/v1/admin/duplicates createDuplicatesRouter': viewer('each side read with getMemorableKnowledge(id, viewer)', HTTP_SWEEP, 'GET /api/v1/admin/duplicates'),
  'src/index.ts USE /api/v1/admin/inconsistencies createInconsistenciesRouter': viewer('both memories read with getMemorableKnowledge(id, viewer)', 'test/slice9Inconsistency.test.ts'),
  'src/index.ts USE /api/v1/ui-prefs createUiPrefsRouter': viewer('the session user\'s own preferences file', 'test/uiPrefsRoute.test.ts'),

  // Operator surfaces that read memory across people.
  'src/index.ts USE /api/v1/admin/memory/purge createMemoryPurgeRouter': operator('purge preview and purge of any person\'s memory'),
  'src/index.ts USE /api/v1/admin/memory/ownerless createMemoryOwnerlessRouter': operator('lists memorable knowledge nobody owns'),
  'src/index.ts USE /api/v1/admin/memory/promotions createMemoryPromoteRouter': operator('promotes scratch memory'),
  'src/index.ts USE /api/v1/admin/memory/backend createMemoryBackendRouter': operator('switches the memory backend; returns status only'),
  'src/index.ts USE /api/v1/admin/bulk-promote createBulkPromotionRouter': operator('bulk scoring and promotion of turns; returns counts'),
  'src/index.ts USE /api/v1/admin/embedding-provider createAdminEmbeddingProviderRouter': operator('embedding provider and re-embedding; returns status'),
  'src/index.ts USE /api/v1/operator/memory/contexts createOperatorMemoryContextsRouter': operator('per-context memory trees of every chat context'),
  'src/index.ts USE /api/v1/operator/receipts createReceiptRoutes': operator('every turn receipt, not filtered by user; PII-free by construction'),
  'src/index.ts USE /api/v1/operator/provenance createProvenanceRoutes': operator('verifies turn receipts'),
  'src/index.ts USE /api/v1/operator/agents createOperatorAgentsRouter': operator('agent management; drain reads the chat session store'),
  'src/index.ts USE /api/v1/routines createRoutinesRouter': operator('cross-tenant routine management, on purpose (#1025)'),
  'src/index.ts USE /api/v1/admin/chats createAdminChatsRouter': operator('assigns owner-less chats to an account (#1762 follow-up)'),
  'src/index.ts USE /api/v1/admin/last-turn createAdminLastTurnRouter': operator('outcome and error class of the last turn, no content'),
  'src/index.ts USE /api/v1/operator/privacy/miss-reports createMissReportRoutes': operator('privacy miss reports operators file'),
  'src/index.ts USE /api/usage createUsageRouter': operator('token and cost aggregates, no content'),
  'src/mcp/wirePublicMcp.ts USE PUBLIC_MCP_PATH createPublicMcpRouter': operator('API key bound by an operator to named tools of one agent; intern-exempt memory tools are never served (isPubliclyServableTool)'),
  'src/routes/adminTokenMount.ts USE ADMIN_TOKEN_PATH (inline)': operator('ADMIN_TOKEN bearer surface: reads and writes /memories directly'),
  'src/routes/graphRouterMounts.ts USE KG_LIFECYCLE_ADMIN_PATH createDevGraphLifecycleRouter': operator('tier histogram and lifecycle sweeps; counts only'),
  'src/routes/graphRouterMounts.ts USE KG_PRIORITIES_ADMIN_PATH createAgentPrioritiesRouter': operator('agent priority settings'),
  'src/routes/graphRouterMounts.ts USE PLUGIN_DOMAINS_ADMIN_PATH createAdminDomainsRouter': operator('plugin domain settings'),

  // Dev surfaces.
  'src/routes/graphRouterMounts.ts USE DEV_GRAPH_PATH createDevGraphRouter': dev('raw graph browser, behind DEV_ENDPOINTS_ENABLED; no production guard yet (#2275)'),
  'src/routes/graphRouterMounts.ts USE DEV_PATH_PREFIX createLoopbackOnly': none('the optional loopback gate in front of /api/dev'),

  // Operator surfaces without memory.
  'src/index.ts USE /api createUiNavigationRouter': none('navigation entries'),
  'src/index.ts USE /api/v1/issues createIssuesRouter': none('files GitHub issues from an operator note'),
  'src/index.ts USE /api/v1/admin/agent-templates createAgentTemplatesRouter': none('agent templates'),
  'src/index.ts USE /api/v1/admin/audience-grants createAudienceGrantRouter': none('audience grant settings'),
  'src/index.ts USE /api/v1/admin/audit createAdminAuditRouter': none('admin audit log of operator actions'),
  'src/index.ts USE /api/v1/admin/auth createAdminAuthRouter': none('auth provider settings'),
  'src/index.ts USE /api/v1/admin/cli-backends createAdminCliBackendsRouter': none('CLI backend settings'),
  'src/index.ts USE /api/v1/admin/credential-asks createCredentialAskRouter': none('credential requests and grants'),
  // #2320 — admin surfaces of the keychain, sandboxes and published apps.
  'src/index.ts USE /api/v1/admin/credentials createAdminCredentialsRouter': none('keychain metadata, grants and revocation (credentials tables); never memory, never a secret'),
  'src/index.ts USE /api/v1/admin/sandboxes createAdminSandboxesRouter': none('sandbox_registry rows (scope key, container ref, last use) and docker rm; no memory, no sandbox file content'),
  'src/index.ts USE /api/v1/admin/publish createAdminPublishRouter': none('publish_apps / publish_versions metadata (version, name, hash); no memory, no app content'),
  'src/index.ts USE /api/v1/admin/model-gateway createModelGatewayStatusRouter': none('model gateway status'),
  'src/index.ts USE /api/v1/admin/model-work createModelWorkRouter': none('operator job status'),
  'src/index.ts USE /api/v1/admin/privacy/field-classification createFieldClassificationRoutes': none('privacy field classification settings'),
  'src/index.ts USE /api/v1/admin/providers createAdminProvidersRouter': none('LLM provider settings'),
  'src/index.ts USE /api/v1/admin/registries createAdminRegistriesRouter': none('plugin registry settings'),
  'src/index.ts USE /api/v1/admin/runtime createRuntimeRouter': none('runtime status'),
  'src/index.ts USE /api/v1/admin/settings createAdminSettingsRouter': none('instance settings'),
  'src/index.ts USE /api/v1/admin/skills createSkillPromotionRouter': none('skill ownership promotion'),
  'src/index.ts USE /api/v1/admin/transcription-provider createAdminTranscriptionProviderRouter': none('transcription provider settings'),
  'src/index.ts USE /api/v1/admin/update createAdminUpdateRouter': none('self-update'),
  'src/index.ts USE /api/v1/admin/directory createAdminDirectoryRouter': operator('directory people, their channel links and MCP connections, behind requireAuth (ADR-0300)'),
  'src/index.ts USE /api/v1/admin/users createAdminUsersRouter': none('account management'),
  'src/index.ts USE /api/v1/directory/connect createDirectoryConnectRouter': none('per-person MCP connect from Teams (ADR-0301)'),
  'src/index.ts USE /api/v1/directory/connect/go createDirectoryConnectRedirect': none('redirect to a pending connect flow (ADR-0301)'),
  'src/index.ts USE /api/v1/admin/vault-status createVaultStatusRouter': none('vault status'),
  'src/index.ts USE /api/v1/agents createAgentDirectoryRouter': none('agent directory'),
  'src/index.ts USE /api/v1/builder createBuilderRouter': none('plugin builder drafts'),
  'src/index.ts USE /api/v1/install createInstallRouter': none('plugin install'),
  'src/index.ts USE /api/v1/install/packages createPackagesRouter': none('plugin packages'),
  'src/index.ts USE /api/v1/install/registry createRegistryInstallRouter': none('registry install'),
  'src/index.ts USE /api/v1/operator createAgentBuilderRouter': none('agent builder'),
  'src/index.ts USE /api/v1/operator createOperatorConsultationRouter': none('consultation and discretion settings'),
  'src/index.ts USE /api/v1/operator credentialBroker.operatorRouter': none('#2319 — per-agent credential grants (agent × credential id); no memory'),
  'src/index.ts USE /api/v1/operator/agents createOperatorAgentArchetypeSettingsRouter': none('archetype settings per agent'),
  'src/index.ts USE /api/v1/operator/agents createOperatorAgentChannelIdentitiesRouter': none('channel identities of agents'),
  'src/index.ts USE /api/v1/operator/archetypes createOperatorArchetypesRouter': none('archetype catalogue'),
  'src/index.ts USE /api/v1/operator/channels createOperatorChannelsRouter': none('channel settings'),
  'src/index.ts USE /api/v1/operator/default-agents createOperatorDefaultAgentsRouter': none('default agent settings'),
  'src/index.ts USE /api/v1/operator/execution createOperatorExecutionRouter': none('execution scopes'),
  'src/index.ts USE /api/v1/operator/teams createOperatorTeamsSignInRouter': none('Teams sign-in'),
  'src/index.ts USE /api/v1/operator/triggers createOperatorTriggersRouter': none('trigger settings'),
  'src/index.ts USE /api/v1/profiles createProfilesRouter': none('profile bundles and their knowledge files, not memory'),
  'src/index.ts USE /api/v1/store/plugins createStoreRouter': none('plugin store'),

  // Mount helpers whose routes are listed elsewhere.
  'src/platform/pluginRouteRegistry.ts USE entry.prefix guarded': none('mounts plugin routes; each is listed as PLUGIN'),
  'src/plugins/builder/runtimeSmoke.ts USE capture.prefix routerLike': none('builder smoke test on a throwaway app'),
  'src/routes/builderPreview.ts USE (no path) (inline)': none('builder preview on a throwaway app'),
  'src/routes/builderPreview.ts USE capture.prefix (inline)': none('builder preview on a throwaway app'),
};

export const TOOLS: Readonly<Record<string, Classification>> = {
  // Kernel tools the orchestrator dispatches itself.
  'packages/harness-orchestrator/src/orchestrator.ts dispatch MEMORY_TOOL_NAME': viewer('the agent\'s /memories under the turn\'s memory binder', TURN_SWEEP, 'memory-tool'),
  'packages/harness-orchestrator/src/orchestrator.ts dispatch KNOWLEDGE_GRAPH_TOOL_NAME': viewer('graph reads through the turn\'s graph view (#2204)', TURN_SWEEP, 'graph-tool'),
  'packages/harness-orchestrator/src/orchestrator.ts dispatch QUERY_DATASET_TOOL_NAME': viewer('datasets owned by the turn\'s resolved user', 'test/queryDatasetTool.test.ts'),
  'packages/harness-orchestrator/src/orchestrator.ts dispatch READ_ATTACHMENT_TOOL_NAME': viewer('attachments bound to the turn\'s own session scope', 'test/attachmentScopeBinding.test.ts'),
  'packages/harness-orchestrator/src/orchestrator.ts dispatch CHAT_PARTICIPANTS_TOOL_NAME': none('who is in the current chat'),
  'packages/harness-orchestrator/src/orchestrator.ts dispatch ASK_USER_CHOICE_TOOL_NAME': none('asks the user'),
  'packages/harness-orchestrator/src/orchestrator.ts dispatch SUGGEST_FOLLOW_UPS_TOOL_NAME': none('suggests replies'),
  'packages/harness-orchestrator/src/orchestrator.ts dispatch FIND_FREE_SLOTS_TOOL_NAME': none('calendar availability'),
  'packages/harness-orchestrator/src/orchestrator.ts dispatch BOOK_MEETING_TOOL_NAME': none('books a meeting'),

  // Process memory.
  'packages/harness-orchestrator/src/plugin.ts register QUERY_PROCESSES_TOOL_NAME': viewer('this agent\'s processes, nothing in a context-bound or boundary-less turn (#2207)', TURN_SWEEP, 'process-tool'),
  'packages/harness-orchestrator/src/plugin.ts register RUN_STORED_PROCESS_TOOL_NAME': viewer('this agent\'s processes, nothing in a context-bound or boundary-less turn (#2207)', TURN_SWEEP, 'process-tool'),
  'packages/harness-orchestrator/src/plugin.ts register WRITE_PROCESS_TOOL_NAME': viewer('writes only into this agent\'s scopes (#2223)', 'test/processMemoryTool.test.ts'),
  'packages/harness-orchestrator/src/plugin.ts register EDIT_PROCESS_TOOL_NAME': viewer('edits only this agent\'s processes (#2223)', 'test/processMemoryTool.test.ts'),

  // Memory providers' handler for the kernel memory tool.
  'packages/harness-memory/src/plugin.ts registerHandler memory': viewer('handler of the memory tool; the kernel scopes it per turn', TURN_SWEEP, 'memory-tool'),
  'packages/harness-memory-postgres/src/plugin.ts registerHandler memory': viewer('handler of the memory tool; the kernel scopes it per turn', TURN_SWEEP, 'memory-tool'),

  // Other kernel and plugin tools.
  'packages/harness-orchestrator/src/plugin.ts register EXECUTE_TOOL_NAME': none('shell in the agent\'s sandbox, which holds no memory store'),
  'packages/harness-orchestrator/src/plugin.ts register PUBLISH_TOOL_NAME': none('publishes a build'),
  'packages/harness-orchestrator/src/plugin.ts register PUBLISH_ROLLBACK_TOOL_NAME': none('rolls a publish back'),
  'packages/harness-orchestrator/src/plugin.ts register TRANSCRIBE_RECORDING_TOOL_NAME': none('transcribes a recording the user supplied'),
  'packages/harness-diagrams/src/plugin.ts register diagramToolSpec': none('renders a diagram from the model\'s input'),
  'packages/harness-plugin-office/src/plugin.ts register createDocxToolSpec': none('writes a document from the model\'s input'),
  'packages/harness-plugin-office/src/plugin.ts register createXlsxToolSpec': none('writes a spreadsheet from the model\'s input'),
  'packages/harness-plugin-web-search/src/plugin.ts register searchToolSpec': none('web search'),
  'packages/harness-plugin-discussion/src/plugin.ts register discussionStartToolSpec': none('starts a discussion; the agent turns it runs recall under their own bounds'),
  'packages/harness-plugin-discussion/src/plugin.ts register discussionPartnersToolSpec': none('lists agents to discuss with'),
  'src/index.ts register reqTool.name': none('request_self_extension: files a pending plugin proposal'),
  'src/plugins/routines/initRoutines.ts registerNativeTool MANAGE_ROUTINE_TOOL_NAME': none('the calling user\'s routines; routines are not memory'),
  'src/triggers/wiring.ts registerNativeTool name': none('trigger tools (on_event, wake_at, …): the conversation\'s own triggers'),
  'src/credentials/credentialBrokerWiring.ts registerNativeTool CREDENTIAL_REQUEST_TOOL_NAME': none('#2319 — calls a declared service through the credential broker as the turn account; no memory'),
  'src/credentials/credentialBrokerWiring.ts registerNativeTool CREDENTIAL_ASK_TOOL_NAME': none('#2319 — creates a credential ask for the turn account; no memory'),
  'src/triggers/wiring.ts registerNativeTool DELIVER_DATA_TOOL_NAME': none('runs one of the agent\'s own read tools under its grants and the audience floor; the rows never reach the model'),

  // Generic registration paths: what they register is listed above or is a plugin's own tool.
  'src/index.ts register name': none('registration callback for the routine and trigger tools above'),
  'src/platform/pluginContext.ts register spec.name': none('ctx.tools.register: a plugin\'s tools, listed above per plugin; their memory reads go through the accessors below'),
  'src/platform/pluginContext.ts registerHandler name': none('ctx.tools.registerHandler: handlers listed above per plugin'),
  'src/agents/subAgentToolHydration.ts register r.name': none('deferred ask_<agent> tools: run another agent\'s turn, which recalls under its own bounds'),
};

const pluginTurns = 'test/memoryAccess/canarySweepSuite.ts';

export const ACCESSORS: Readonly<Record<string, Classification>> = {
  'knowledgeGraph.searchTurns': viewer('turn search bounded to the turn\'s graph boundary', pluginTurns, 'plugin-accessor'),
  'knowledgeGraph.findEntityCapturedTurns': viewer('captured turns bounded to the turn\'s graph boundary', pluginTurns, 'plugin-accessor'),
  'knowledgeGraph.getNeighbors': viewer('neighbours filtered by ACL and graph boundary (#2208)', pluginTurns, 'plugin-neighbors'),
  'knowledgeGraph.stats': none('node counts, no content'),
  'knowledgeGraph.ingestEntities': none('writes entities'),
  'knowledgeGraph.ingestFacts': none('writes facts'),
  'memory.readFile': viewer('the plugin\'s own /memories subtree', pluginTurns, 'plugin-accessor'),
  'memory.list': viewer('the plugin\'s own /memories subtree', pluginTurns, 'plugin-accessor'),
  'memory.exists': viewer('the plugin\'s own /memories subtree', pluginTurns, 'plugin-accessor'),
  'memory.writeFile': none('writes the plugin\'s own subtree'),
  'memory.createFile': none('writes the plugin\'s own subtree'),
  'memory.delete': none('deletes in the plugin\'s own subtree'),
  'services.get': viewer('knowledgeGraph, memoryStore and processMemory come bounded to the turn (ADR-0044)', pluginTurns, 'plugin-service'),
  'services.getOptional': viewer('same bounded services as services.get (ADR-0044)', pluginTurns, 'plugin-service'),
  'services.has': none('presence check'),
  'services.provide': none('publishes a service'),
  'services.replace': none('wraps a service the plugin may already read'),
  'tools.invoke': viewer('memory runs in the plugin\'s own scope (#909); process tools return nothing outside a turn', 'test/pluginContextToolsInvokeMemory.test.ts'),
  'tools.register': none('registers a tool (listed under TOOLS)'),
  'tools.registerHandler': none('registers a handler (listed under TOOLS)'),
  // An archetype plugin gets a schema of its own; any other plugin runs on the
  // shared pool, where memory tables are readable. Exists only with an
  // operator's grant of `permissions.sql`.
  'sql.query': operator('raw SQL; on the shared pool unless the plugin is an archetype with its own schema; needs an operator grant of permissions.sql'),
  'sql.transaction': operator('raw SQL; on the shared pool unless the plugin is an archetype with its own schema; needs an operator grant of permissions.sql'),
  'sql.runMigrations': none('the plugin\'s own migrations'),
  'sql.seedLedger': none('the plugin\'s own migration ledger'),
  'subAgent.ask': none('asks another agent, whose turn recalls under its own bounds'),
  'subAgent.has': none('presence check'),
  'subAgent.list': none('agent ids'),
  'config.get': none('plugin config'),
  'config.require': none('plugin config'),
  'config.set': none('plugin config'),
  'secrets.get': none('plugin secrets'),
  'secrets.require': none('plugin secrets'),
  'secrets.keys': none('plugin secrets'),
  'secrets.set': none('plugin secrets'),
  'secrets.delete': none('plugin secrets'),
  'events.emit': none('emits an event'),
  'flows.publicUrl': none('URL helper'),
  'flows.signState': none('OAuth state helper'),
  'flows.verifyState': none('OAuth state helper'),
  'http.fetch': none('outbound HTTP'),
  'net.connect': none('outbound socket'),
  'jobs.register': none('registers a job'),
  'llm.complete': none('model call with the plugin\'s own input'),
  'log': none('logging'),
  'mcp.callTool': none('external MCP server'),
  'mcp.listServers': none('external MCP server'),
  'mcp.listTools': none('external MCP server'),
  'notifications.send': none('sends a notification'),
  'notifications.registerChannel': none('registers a channel'),
  'oauthTokens.get': none('the plugin\'s OAuth tokens'),
  'operatorAuth.hasValidSession': none('session check'),
  'operatorAuth.sessionPrincipal': none('session principal'),
  'operatorAuth.recordAdminAction': none('writes the admin audit log'),
  'routes.register': none('registers a route (listed under ROUTES as PLUGIN)'),
  'uiRoutes.register': none('registers a UI route'),
  'uiRoutes.registerNav': none('registers a nav entry'),
  'scratch.path': none('the plugin\'s scratch directory'),
  'status.report': none('reports plugin status'),
  'status.clear': none('clears plugin status'),
};
