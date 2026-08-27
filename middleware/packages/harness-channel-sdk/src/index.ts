// Channel plugin contract
export type {
  ChannelPlugin,
  ChannelHandle,
  ChannelRegistry,
  ChannelPluginResolver,
} from './plugin.js';

// What channels call on the core
export type {
  CoreApi,
  HttpMethod,
  LogLevel,
  ChannelSocket,
  ChannelSocketHandler,
  ChannelSessionClaims,
} from './coreApi.js';

// #330 B1 — group-conversation primitives: conversation type + roster,
// membership lifecycle events, and Principal-addressed targeted delivery.
// All optional capabilities; classic adapters are untouched.
export {
  isGroupConversation,
  type ConversationType,
  type ConversationParticipant,
  type ConversationRoster,
  type ConversationRosterProvider,
} from './conversationRoster.js';
export type {
  BotAddedEvent,
  ConversationMembershipEvent,
  MembersAddedEvent,
  MembersRemovedEvent,
} from './membershipEvent.js';
export type {
  TargetedDeliveryOutcome,
  TargetedMessage,
  TargetedSendDiagnostic,
  TargetedSendProvider,
  TargetedSendReport,
} from './targetedSend.js';
// #330 C3b - conversation-addressed proactive send (group nudges).
export type { ConversationSendProvider } from './conversationSend.js';

// Orchestrator access — the typed, blessed way for a channel to resolve the
// ChatAgent it drives turns with (alternative to CoreApi.handleTurnStream when
// a folded SemanticAnswer / richer control is wanted).
export {
  CHAT_AGENT_SERVICE,
  getChatAgent,
  getChatAgentBundle,
  type ChatAgentBundle,
} from './chatAgentService.js';

// US7 per-binding routing — resolve the *scoped* ChatAgent bound to a turn's
// (channelType, channelKey) via the platform channelResolver. Direct-agent
// channels (Teams, Telegram) MUST call this per turn instead of caching
// getChatAgent(ctx), so each conversation reaches the Agent it was bound to.
export {
  CHANNEL_RESOLVER_SERVICE,
  resolveChatAgentForChannel,
  type ChannelBindingResolver,
  type ChannelResolveResult,
  type ChannelResolveDecision,
} from './channelRouting.js';

// Inbound message shape
export type {
  IncomingTurn,
  ChannelUserRef,
  ChannelUserKind,
  IncomingAttachment,
  PlatformIdentity,
  CanvasViewState,
  CanvasSelection,
} from './incoming.js';

// Orchestrator → channel stream envelope (back-compat re-export)
export type { ChatStreamEvent } from './streamEvent.js';

// AI-Act Art. 50 machine-readable provenance marker for the envelope-controlled
// egress paths (public chat API + public MCP server). Issue #647.
export {
  AI_PROVENANCE_HEADER,
  AI_PROVENANCE_HEADER_VALUE,
  AI_PROVENANCE_META_KEY,
  ENVELOPE_PROVENANCE,
  type EnvelopeProvenance,
} from './provenance.js';

// Omadia UI canvas surface contracts (omadia-canvas-protocol/1.0). Additive —
// the `surface_*` family is folded into `ChatStreamEvent`; classic channels
// default-ignore it.
export type {
  RevisionId,
  DataRef,
  OutgoingSurface,
  PendingCanvasSurface,
  SurfaceStreamEvent,
  SurfaceSnapshotEvent,
  SurfacePatchEvent,
  SurfaceDataRefCreatedEvent,
  SurfaceDataRefInvalidatedEvent,
  SurfaceActionResultEvent,
  SurfaceLocalActionEvent,
  SurfaceErrorEvent,
  SurfaceMutationResolvedEvent,
} from './surface.js';

// Orchestrator surface contract — lifted from the kernel in S+10-2 so
// channel-plugins-final (S+11) and the orchestrator-plugin (S+10-3/4) can
// consume `ChatAgent` without depending on the concrete Orchestrator class.
export type {
  ChatAgent,
  ChatStreamObserver,
  ChatTurnInput,
  ChatTurnAttachment,
  ChatTurnResult,
  VerifierResultSummary,
  RunTracePayload,
  RunStatus,
  RunToolCall,
  RunAgentInvocation,
  DiagramAttachment,
  OutgoingFileAttachment,
  PendingUserChoice,
  PendingSlotCard,
  // #544 W2-1 — MCP mid-call input request.
  McpInputCardField,
  PendingMcpInputCard,
  PendingRoutineList,
  AgentMeta,
} from './chatAgent.js';

// Conversion helper from kernel-shaped result to channel-agnostic outgoing
// message — lifted from `services/orchestrator.ts` in S+10-2 so channel
// adapters can call it without crossing into kernel internals.
export { toSemanticAnswer } from './toSemanticAnswer.js';

// #332 Layer 1 — plain-text fallback so even a minimal connector (no rich-card
// UI) can append a readable, harness-sourced consulted-agents footer line.
export { agentsConsultedFooterText } from './toSemanticAnswer.js';
// #544 W2-1 — plain-text fallback for channels without form support.
export { withMcpInputPrompt } from './toSemanticAnswer.js';

// #332 Layer 1 (gap-closure) — shared derivation so streaming clients
// (web-ui) and non-streaming `toSemanticAnswer` callers (Teams et al.) build
// the IDENTICAL curated agentsConsulted array from the same run-trace.
export { deriveAgentsConsulted } from './toSemanticAnswer.js';

// AI-Act Art. 50 channel-agnostic AI disclosure carrier (#643, epic #642). The
// structured field rides `SemanticAnswer.aiDisclosure`; the same line is folded
// into `text` (the one field connectors MUST render) by `toSemanticAnswer`. This
// module ships the carrier, the shipping-default policy, the DE/EN text composer
// and the first-turn-per-scope fold decision; per-turn resolution + operator
// setup fields land in the orchestrator in #644. Distinct from the envelope
// marker for the API/MCP paths (#647, exported above).
export {
  DEFAULT_AI_DISCLOSURE_POLICY,
  InMemoryDisclosureSeenStore,
  composeDisclosureText,
  applyAiDisclosure,
  resolveAiDisclosure,
} from './aiDisclosure.js';
export type {
  AiDisclosure,
  AiDisclosureLevel,
  AiDisclosurePolicy,
  DisclosureSeenStore,
  ComposeDisclosureOptions,
  ApplyAiDisclosureContext,
  ApplyAiDisclosureResult,
} from './aiDisclosure.js';

// Org security postures + provenance-labelled inbound screening (#579). Shared
// primitives — the posture model, tighten-only floor math, the provenance
// bundler + judge-facing legend, the payload renderer, the shipping-default
// policy and the unscreened marker. The screener call + quarantine/fail-open
// wiring lives in the orchestrator; mirror of Privacy Shield on the ingress side.
export {
  POSTURE_ORDER,
  tightenPosture,
  screeningEnabled,
  formatSourceTag,
  isScreenableSource,
  bundleProvenance,
  hasScreenableContent,
  renderScreeningPayload,
  UNSCREENED_MARKER,
  DEFAULT_SECURITY_POSTURE_POLICY,
} from './securityPosture.js';
export type {
  SecurityPosture,
  ProvenancePair,
} from './securityPosture.js';

// Shell-normalizing command policy for gating agent-executed commands (#580).
// The reusable primitive: the shell normalizer + tokenizer, the rule/decision
// model, the shipped org floor and the cascade evaluator. Pure and byte-stable;
// the honest-inert enforcement seam lives in the orchestrator (commandPolicyGuard).
export {
  normalizeCommand,
  decideCommand,
  defaultCommandPolicy,
  DEFAULT_ORG_FLOOR,
  MAX_SUBSTITUTION_DEPTH,
} from './commandPolicy.js';
export type {
  CommandDecision,
  CommandDecisionLayer,
  CommandDecisionResult,
  CommandMatcher,
  CommandPolicy,
  CommandRule,
  NormalizedCommand,
  ParsedCommand,
} from './commandPolicy.js';

// Semantic outgoing-message contracts (connectors render native)
export type {
  SemanticAnswer,
  OutgoingAttachment,
  VerifierBadge,
  FollowUpOption,
  OutgoingInteractive,
  OutgoingChoiceCard,
  OutgoingSlotPicker,
  OutgoingTopicAsk,
  // #544 W2-1 — MCP mid-call input form.
  OutgoingMcpInputForm,
  CaptureDisclosure,
  AgentConsultation,
  DelegatedAnswer,
  DirectLineSessionState,
} from './outgoing.js';

// Channel-agnostic store interfaces
export type {
  ConversationTurn,
  ConversationHistoryStore,
  PersistedAttachment,
  AttachmentPutInput,
  AttachmentStore,
} from './stores.js';

// Phase 5B: in-memory implementation channel plugins can construct
// directly. Lifted from `middleware/src/services/conversationHistory.ts`
// so dynamic-imported channels don't depend on a kernel singleton.
export {
  InMemoryConversationHistoryStore,
  type InMemoryConversationHistoryStoreOptions,
  type PendingTopicDecision,
} from './inMemoryConversationHistory.js';

// NO_REPLY sentinel: agent emits this literal when it has nothing to say,
// channel adapters drop the message before forwarding to the provider.
export { NO_REPLY_SENTINEL, isNoReply, logNoReplyDrop } from './noReply.js';

// Phase B+ — channel-key discovery for the /operator/channels dashboard.
// Each channel-kind plugin contributes a ChannelKeyDirectory during
// activate(); the kernel aggregates them and exposes the union over REST.
export type {
  ChannelKeyDirectory,
  ChannelKeyEntry,
} from './channelKeyDirectory.js';

// #575 Phase 1 — the typed session scope. Lives in the channel SDK because it
// is consumed by the orchestrator, the kernel AND the channel plugins, and this
// package is the leaf all three already depend on. `sessionScope` stays a
// `string` on the plugin-facing contract (spec §8 D2); the type is produced and
// consumed internally by parsing at ingress.
export {
  SHARED_SCOPE_TOKENS,
  SYSTEM_SCOPE_ORIGINS,
  formatSessionScope,
  isAddressableScope,
  memoryContextKey,
  parseSessionScope,
  scopeGraphKey,
  unsharedConversationScope,
  type ScopeId,
  type SystemScopeOrigin,
  type UnscopedReason,
} from './scopeId.js';

// W5 memory-ACL — where a turn came from, and the memory axes that follow.
// Re-exported from the package root because the PRODUCERS live outside this
// repository: `omadia-channel-teams` and `omadia-channel-telegram` resolve
// `@omadia/channel-sdk` to this package's built `dist/index.d.ts`, so a type
// that is not named here cannot be named by a channel plugin at all.
export {
  CONTEXT_FREE_MEMORY_AXES,
  CONTEXT_MEMORY_CHANNEL_TYPES,
  memoryAxesForOrigin,
  teamAxisKey,
  type MemoryAxes,
  type MemoryAxis,
  type TurnOrigin,
} from './turnOrigin.js';

// #333 Phase 1 — the typed principal. Same home as `ScopeId` and for the same
// reason: Conductor (`middleware/src`), the orchestrator and the kernel all
// depend on this package and it depends on none of them. `Principal` says WHO;
// it carries no entitlement, because #575 — not #333 — evaluates permissions
// (spec §6).
export {
  PRINCIPAL_KINDS,
  canonicalizePrincipalRef,
  formatPrincipal,
  makePrincipal,
  parsePrincipal,
  principalRef,
  principalsEqual,
  type Principal,
  type PrincipalKind,
} from './principal.js';

// #333 Phase 2 — where a Principal's roles come from. Still no permission is
// evaluated here: these resolve FACTS (Entra group membership, an Odoo HR
// record) that #575 later intersects into decisions. The catalog/registry split
// mirrors `auth/providerRegistry.ts` — and matters more, because a role source
// decides what you ARE once inside, not merely whether you get in.
export {
  RoleSourceCatalog,
  RoleSourceRegistry,
  type AggregateRoleLookup,
  type RoleLookup,
  type RoleLookupUnavailableCode,
  type RoleSource,
} from './roleSource.js';

// #333 Phase 3 — the inverse direction: role → holders, which Conductor already
// depends on (`roleStore.ts:22` calls the external resolver "a follow-up").
// Introducing sources beyond the local table makes a PARTIALLY-known holder list
// possible for the first time, and two Conductor decisions fail OPEN on one —
// `quorum='all'` completeness and "no holder → take the fallback". Hence
// `AggregateHolderLookup.partial`.
export {
  RoleHolderCatalog,
  RoleHolderRegistry,
  type AggregateHolderLookup,
  type HolderLookup,
  type HolderLookupUnavailableCode,
  type RoleHolderSource,
} from './roleHolderSource.js';

// #575 Phase 2 — the first module that DECIDES something. #333 produces
// Principals and says what they are entitled to; this consumes them and answers
// "given who is present, what may happen in this room?". Everything fails
// closed, because the intersection of nothing is everything and an empty roster
// already means "unknown" in `ChatParticipantsProvider`'s own contract.
export {
  audienceFloor,
  UNRESTRICTED_HOST_CAPABILITY,
  floorAllowsHost,
  floorDeniesHost,
  floorPermits,
  hostCapability,
  resolveAudience,
  type Audience,
  type AudienceFloor,
  type AudienceMember,
  type AudienceUnknownReason,
  type Capability,
  type ResolvedAudienceMember,
} from './audienceFloor.js';

// #575 Phase 2 — where a principal's capabilities come from. Capabilities UNION
// within one principal (two roles give you both) and INTERSECT across the
// audience (a room may only do what everyone may do); the two live apart so the
// directions cannot be confused.
export {
  InMemoryGrantStore,
  resolveCapabilities,
  type GrantStore,
} from './grants.js';

// #578 Phase 1 — the credential keychain's data model: encrypted, fingerprinted
// credentials owned by a principal, and the grants (audience scope, once vs
// standing, purpose, expiry, revocation) that let someone use one. See
// `credentials.ts` for why this is a dedicated store rather than a second
// `GrantStore`.
export {
  CREDENTIAL_GRANT_MODES,
  CREDENTIAL_KINDS,
  fingerprintSecret,
  InMemoryCredentialStore,
  isGrantActive,
  validateNewGrantInput,
  type Credential,
  type CredentialBrokerDeclaration,
  type CredentialGrant,
  type CredentialGrantId,
  type CredentialGrantMode,
  type CredentialId,
  type CredentialInjectionScheme,
  type CredentialKind,
  type CredentialStore,
  type EncryptedSecretMaterial,
  type NewCredentialGrantInput,
  type NewCredentialInput,
} from './credentials.js';
