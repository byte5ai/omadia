/**
 * US9 / T042 — operator Agents REST router tests.
 *
 *  1. GET / returns the agent list + memory_scope + active flag from the
 *     fake registry.
 *  2. POST / creates an agent; PATCH /:slug updates name/status/privacy;
 *     DELETE /:slug removes it.
 *  3. PUT /:slug/plugins replaces the plugin set; PUT /:slug/bindings
 *     replaces the channel bindings (both call reload() afterwards).
 *  4. PUT /fallback sets/clears platform_settings.fallback_agent_id.
 *  5. POST /:slug/drain and /:slug/kill call registry.forceInvalidate.
 *  6. ConfigValidationError surfaces as HTTP 409.
 *  7. Zod errors surface as HTTP 400 with a structured `issues` array.
 *  8. 503 when no orchestratorRegistry is published.
 *  9. W0c (#861): GET /:slug/plugins reads the assignment; PATCH
 *     /:slug/plugins flips ONE plugin (config preserved, fallback keeps the
 *     global config, unassigned+disable → 404); GET /:slug/grants returns
 *     the agent's tool grants (grant epoch included) + the plugin MCP
 *     grants of its assigned plugins, and 503s without a graph store.
 * 10. W1a (#860): POST /:slug/teams-identity ensures the identity row (one
 *     per agent) and enqueues the provisioning job WITHOUT awaiting it;
 *     GET /:slug/teams-identity projects the row incl. the teams_bots[]
 *     entry with a secret REF (never secret material); both 503 when the
 *     deps are unwired, POST 503s when teamsProvisioner@1 is missing.
 * 11. W2a (#860): projectTeamsBotConfig is the router's SINGLE teams_bot
 *     projection (GET must emit exactly its output), and the GET adds
 *     `last_error_detail` — the runner's own classifier decoding the
 *     last_error sentence, so the UI never parses English.
 * 12. W2a (#860): GET /:slug/teams is the DERIVED team↔agent read model —
 *     an install is reported only once the row says 'installed', consent
 *     comes from the runner's recorded failure, and the response advertises
 *     what the platform cannot do (uninstall / enumerate / multi-team).
 *     POST /:slug/teams records the target and resumes the chain (idempotent
 *     for the same team, 409 for a second one), DELETE answers 501.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { after, afterEach, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import {
  ConfigValidationError,
  type AgentGraphStore,
  type ChatSessionStore,
  type ConfigStore,
  type OrchestratorRegistry,
} from '@omadia/orchestrator';
import {
  CONTEXT_MEMORY_MODES,
  createOperatorAgentsRouter,
  defaultTeamsBotSecretRef,
  projectInstalledTeams,
  projectTeamsBotConfig,
  projectTeamsConsent,
  TEAMS_ASSIGNMENT_CAPABILITIES,
  TEAMS_UNINSTALL_MIN_CONNECTOR_VERSION,
  teamsAssignmentCapabilities,
  type OperatorTeamsIdentityRecord,
  type OperatorTeamsInstallRecord,
} from '../src/routes/operatorAgents.js';
import type { TeamsProvisionerAccessor } from '../src/platform/teamsProvisionerService.js';
import type { TeamsTargetKind } from '../src/platform/teamsInstallTarget.js';
import {
  armNotConfiguredDetail,
  consentMissingDetail,
  throttledDetail,
} from '../src/services/teamsProvisioningJob.js';
import {
  InMemoryInstalledRegistry,
  type InstalledRegistry,
} from '../src/plugins/installedRegistry.js';
import {
  CHANNEL_TEAMS_PLUGIN_ID,
  TEAMS_BOTS_CONFIG_KEY,
} from '../src/services/teamsBotsConfigSync.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

interface AgentMem {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  privacyProfile: 'strict' | 'default';
  status: 'enabled' | 'disabled';
  /** W5 memory-ACL rollout mode (#899). Optional exactly like the real
   *  `AgentRow`, so a row seeded without it models a pre-0050 agent. */
  contextMemory?: 'off' | 'enforce' | 'enforce-strict';
  createdAt: Date;
  updatedAt: Date;
}
interface PluginMem {
  agentId: string;
  pluginId: string;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: Date;
}
interface BindingMem {
  channelType: string;
  channelKey: string;
  agentId: string;
  createdAt: Date;
}

let idCounter = 0;
function newId(): string {
  // Monotonic, not time-based: two agents created in the same millisecond
  // must still get distinct ids (the W0c grants test creates two).
  idCounter += 1;
  return `00000000-0000-0000-0000-${String(idCounter).padStart(12, '0')}`;
}

/**
 * Hand-rolled fake ConfigStore. Reuses the production ConfigStore's method
 * names so the type narrows when handed to the router; only the methods
 * the router calls are implemented.
 */
class FakeConfigStore {
  agents = new Map<string, AgentMem>();
  plugins = new Map<string, PluginMem>(); // key: agentId|pluginId
  bindings = new Map<string, BindingMem>(); // key: type|key
  fallbackId: string | null = null;

  listAgents(): Promise<AgentMem[]> {
    return Promise.resolve(Array.from(this.agents.values()));
  }
  listAllAgentPlugins(): Promise<PluginMem[]> {
    return Promise.resolve(Array.from(this.plugins.values()));
  }
  listChannelBindings(): Promise<BindingMem[]> {
    return Promise.resolve(Array.from(this.bindings.values()));
  }
  listAgentPlugins(agentId: string): Promise<PluginMem[]> {
    return Promise.resolve(
      Array.from(this.plugins.values()).filter((p) => p.agentId === agentId),
    );
  }
  listChannelBindingsForAgent(agentId: string): Promise<BindingMem[]> {
    return Promise.resolve(
      Array.from(this.bindings.values()).filter((b) => b.agentId === agentId),
    );
  }
  getPlatformSettings(): Promise<{ fallbackAgentId: string | null; updatedAt: Date }> {
    return Promise.resolve({ fallbackAgentId: this.fallbackId, updatedAt: new Date() });
  }
  getAgentBySlug(slug: string): Promise<AgentMem | undefined> {
    for (const a of this.agents.values()) if (a.slug === slug) return Promise.resolve(a);
    return Promise.resolve(undefined);
  }
  createAgent(input: {
    slug: string;
    name: string;
    description?: string | null;
    privacyProfile?: 'strict' | 'default';
    status?: 'enabled' | 'disabled';
  }): Promise<AgentMem> {
    for (const a of this.agents.values()) {
      if (a.slug === input.slug) {
        return Promise.reject(new ConfigValidationError(`slug "${input.slug}" exists`));
      }
    }
    const row: AgentMem = {
      id: newId(),
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      privacyProfile: input.privacyProfile ?? 'default',
      status: input.status ?? 'enabled',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.agents.set(row.id, row);
    return Promise.resolve(row);
  }
  updateAgent(
    id: string,
    patch: Partial<{
      name: string;
      description: string | null;
      privacyProfile: 'strict' | 'default';
      status: 'enabled' | 'disabled';
      contextMemory: 'off' | 'enforce' | 'enforce-strict';
    }>,
  ): Promise<AgentMem> {
    const row = this.agents.get(id);
    if (!row) return Promise.reject(new ConfigValidationError(`not found`));
    const updated: AgentMem = { ...row, ...patch, updatedAt: new Date() };
    this.agents.set(id, updated);
    return Promise.resolve(updated);
  }
  deleteAgent(id: string): Promise<void> {
    this.agents.delete(id);
    return Promise.resolve();
  }
  upsertAgentPlugin(
    agentId: string,
    input: { pluginId: string; config?: Record<string, unknown>; enabled?: boolean },
  ): Promise<PluginMem> {
    const row: PluginMem = {
      agentId,
      pluginId: input.pluginId,
      config: input.config ?? {},
      enabled: input.enabled ?? true,
      createdAt: new Date(),
    };
    this.plugins.set(`${agentId}|${input.pluginId}`, row);
    return Promise.resolve(row);
  }
  removeAgentPlugin(agentId: string, pluginId: string): Promise<void> {
    this.plugins.delete(`${agentId}|${pluginId}`);
    return Promise.resolve();
  }
  createChannelBinding(
    agentId: string,
    input: { channelType: string; channelKey: string },
  ): Promise<BindingMem> {
    const key = `${input.channelType}|${input.channelKey}`;
    const existing = this.bindings.get(key);
    if (existing && existing.agentId !== agentId) {
      return Promise.reject(
        new ConfigValidationError(`binding (${key}) already bound to another agent`),
      );
    }
    const row: BindingMem = { ...input, agentId, createdAt: new Date() };
    this.bindings.set(key, row);
    return Promise.resolve(row);
  }
  removeChannelBinding(channelType: string, channelKey: string): Promise<void> {
    this.bindings.delete(`${channelType}|${channelKey}`);
    return Promise.resolve();
  }
  resolveBinding(channelType: string, channelKey: string): Promise<BindingMem | undefined> {
    return Promise.resolve(this.bindings.get(`${channelType}|${channelKey}`));
  }
  setFallbackAgentId(id: string | null): Promise<{ fallbackAgentId: string | null; updatedAt: Date }> {
    this.fallbackId = id;
    return Promise.resolve({ fallbackAgentId: id, updatedAt: new Date() });
  }
}

interface ToolGrantMem {
  id: string;
  agentId: string | null;
  subAgentId: string | null;
  toolKind: string;
  toolRef: string;
  mcpServerId: string | null;
  config: Record<string, unknown>;
  createdAt: Date;
  grantEpoch: string | null;
}
interface PluginMcpGrantMem {
  pluginId: string;
  mcpServerId: string;
  grantedBy: string;
  grantedAt: Date;
}

/** Fake AgentGraphStore — only the three reads GET /:slug/grants uses. */
class FakeGraphStore {
  toolGrants: ToolGrantMem[] = [];
  pluginGrants: PluginMcpGrantMem[] = [];
  servers: Array<{ id: string; name: string }> = [];
  /** agentId → its sub-agent ids, mirroring agent_subagents. */
  subAgentsOf: Record<string, readonly string[]> = {};

  listToolGrantsForAgent(agentId: string): Promise<ToolGrantMem[]> {
    // Mirrors the real store's contract (W0c): rows held directly by the
    // agent PLUS rows held by one of ITS sub-agents (agent_id NULL there).
    const subs = new Set(this.subAgentsOf[agentId] ?? []);
    return Promise.resolve(
      this.toolGrants.filter(
        (g) => g.agentId === agentId || (g.subAgentId !== null && subs.has(g.subAgentId)),
      ),
    );
  }
  listPluginMcpGrantsForPlugins(
    pluginIds: readonly string[],
  ): Promise<PluginMcpGrantMem[]> {
    const wanted = new Set(pluginIds);
    return Promise.resolve(this.pluginGrants.filter((g) => wanted.has(g.pluginId)));
  }
  listMcpServers(): Promise<Array<{ id: string; name: string }>> {
    return Promise.resolve(this.servers);
  }
}

/** W1a (#860) — in-memory `agent_teams_identities` store stub. */
interface TeamsIdentityMem {
  agentId: string;
  botSlug: string;
  displayName: string;
  state: string;
  teamId: string | null;
  appId: string | null;
  tenantId: string | null;
  teamsAppId: string | null;
  teamsAppExternalId: string | null;
  /** Migration 0054 — what `teamId` actually addresses. Optional, exactly
   *  like the router's port, so a row seeded without it still reads as the
   *  historical `'team'`. */
  targetKind?: TeamsTargetKind;
  lastError: string | null;
  /** Optional exactly like the router's port — a row seeded without
   *  timestamps must stay assignable to `OperatorTeamsIdentityRecord`. */
  createdAt?: Date;
  updatedAt?: Date;
}

class FakeTeamsIdentityStore {
  rows = new Map<string, TeamsIdentityMem>();
  ensureCalls: Array<{
    agentId: string;
    botSlug: string;
    displayName: string;
    teamId?: string;
  }> = [];
  enqueueFailures: Array<{ agentId: string; message: string }> = [];
  /** When set, ensureForAgent throws it (bot_slug_taken shape). */
  ensureError: Error | undefined;

  getByAgentId(agentId: string): Promise<OperatorTeamsIdentityRecord | undefined> {
    return Promise.resolve(this.rows.get(agentId));
  }
  ensureForAgent(input: {
    agentId: string;
    botSlug: string;
    displayName: string;
    teamId?: string;
  }): Promise<OperatorTeamsIdentityRecord> {
    this.ensureCalls.push({ ...input });
    if (this.ensureError) return Promise.reject(this.ensureError);
    const existing = this.rows.get(input.agentId);
    if (existing) {
      // Mirrors the real store's `team_id = COALESCE(EXCLUDED.team_id, …)`:
      // an ensure re-targets the install, never the identity itself.
      if (input.teamId !== undefined) existing.teamId = input.teamId;
      return Promise.resolve(existing);
    }
    const row: TeamsIdentityMem = {
      ...input,
      teamId: input.teamId ?? null,
      state: 'pending',
      appId: null,
      tenantId: null,
      teamsAppId: null,
      teamsAppExternalId: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.set(input.agentId, row);
    return Promise.resolve(row);
  }
  recordEnqueueFailure(agentId: string, message: string): Promise<void> {
    this.enqueueFailures.push({ agentId, message });
    const row = this.rows.get(agentId);
    if (row) row.lastError = `enqueue_failed: ${message}`;
    return Promise.resolve();
  }
  /** #900 — mirrors AgentTeamsIdentityStore.clearTeamInstall. */
  clearTeamInstalls: string[] = [];
  clearTeamInstall(agentId: string): Promise<OperatorTeamsIdentityRecord> {
    this.clearTeamInstalls.push(agentId);
    const row = this.rows.get(agentId);
    if (!row) return Promise.reject(new Error(`no identity row for ${agentId}`));
    row.state = 'catalog_uploaded';
    row.teamId = null;
    row.lastError = null;
    return Promise.resolve(row);
  }
}

/**
 * #900 — the connector's `uninstallFromTeam`, and the ability to LEAVE IT
 * OUT. A connector < 0.4.0 publishes an accessor without the method at all,
 * which is exactly what the route has to feature-detect, so the fake models
 * absence as a missing property rather than a method that throws.
 */
class FakeTeamsProvisioner {
  calls: Array<{ teamId: string; teamsAppId: string }> = [];
  outcome: 'uninstalled' | 'already-absent' = 'uninstalled';
  /** When set, uninstallFromTeam rejects with it (e.g. ConsentMissingError). */
  error: Error | undefined;

  uninstallFromTeam(input: {
    readonly teamId: string;
    readonly teamsAppId: string;
  }): Promise<{
    readonly outcome: 'uninstalled' | 'already-absent';
    readonly value: { readonly teamId: string; readonly teamsAppId: string };
  }> {
    this.calls.push({ ...input });
    if (this.error) return Promise.reject(this.error);
    return Promise.resolve({ outcome: this.outcome, value: { ...input } });
  }
}

/**
 * A connector that can remove a CHAT install too — `uninstallFromChat`, a
 * different Graph endpoint from `uninstallFromTeam` (`/chats/{id}` versus
 * `/teams/{id}`).
 *
 * A SUBCLASS rather than a flag on the base, so the base keeps modelling the
 * connector that installs into chats but cannot remove from them — the exact
 * skew the route has to feature-detect, and the state in which handing a chat
 * id to `uninstallFromTeam` produced a 400 from Graph.
 */
class FakeTeamsChatProvisioner extends FakeTeamsProvisioner {
  chatCalls: Array<{ chatId: string; teamsAppId: string }> = [];

  uninstallFromChat(input: {
    readonly chatId: string;
    readonly teamsAppId: string;
  }): Promise<{
    readonly outcome: 'uninstalled' | 'already-absent';
    readonly value: { readonly chatId: string; readonly teamsAppId: string };
  }> {
    this.chatCalls.push({ ...input });
    if (this.error) return Promise.reject(this.error);
    return Promise.resolve({ outcome: this.outcome, value: { ...input } });
  }
}

/** A connector too old to know about uninstalls: no method, not a stub. */
class LegacyTeamsProvisioner {}

/** Migration 0051 — the persisted team↔agent bindings, in memory. Bound only
 *  by the multi-team cases below, so every pre-existing test keeps running
 *  against the single-column read model it was written for. */
class FakeTeamsInstallStore {
  rows: OperatorTeamsInstallRecord[] = [];
  nameWrites: Array<{ teamId: string; displayName: string }> = [];
  removeCalls: Array<{ agentId: string; teamId: string }> = [];

  listForAgent(agentId: string): Promise<readonly OperatorTeamsInstallRecord[]> {
    return Promise.resolve(this.rows.filter((row) => row.agentId === agentId));
  }

  setDisplayName(
    agentId: string,
    teamId: string,
    displayName: string,
  ): Promise<boolean> {
    this.nameWrites.push({ teamId, displayName });
    const row = this.rows.find(
      (entry) => entry.agentId === agentId && entry.teamId === teamId,
    );
    if (!row) return Promise.resolve(false);
    this.rows = this.rows.map((entry) =>
      entry === row
        ? { ...entry, teamDisplayName: displayName, displayNameSyncedAt: new Date() }
        : entry,
    );
    return Promise.resolve(true);
  }

  remove(agentId: string, teamId: string): Promise<boolean> {
    this.removeCalls.push({ agentId, teamId });
    const before = this.rows.length;
    this.rows = this.rows.filter(
      (entry) => !(entry.agentId === agentId && entry.teamId === teamId),
    );
    return Promise.resolve(this.rows.length < before);
  }
}

/** Migration 0053 (#915) — the provisioning progress log, in memory. Bound
 *  only by the timeline cases below, so every pre-existing test keeps running
 *  against the pre-0053 response shape it was written for. */
class FakeTeamsEventStore {
  rows: Array<{
    id: string;
    agentId: string;
    at: Date;
    step: string;
    status: string;
    attempt: number | null;
    detail: string | null;
  }> = [];
  /** When set, `listRecent` rejects with it — the "table is unreadable"
   *  fixture. A status response must survive that. */
  readError: Error | undefined;
  lastLimit: number | undefined;

  listRecent(agentId: string, limit?: number): Promise<typeof this.rows> {
    this.lastLimit = limit;
    if (this.readError) return Promise.reject(this.readError);
    return Promise.resolve(
      this.rows.filter((row) => row.agentId === agentId).slice(0, limit ?? 30),
    );
  }
}

/** W1a (#860) — stubbed provisioning job runner. `enqueue` returns a promise
 *  that NEVER settles: if the POST handler awaited the run, its test would
 *  hang into the suite timeout, so a green run proves the async contract. */
class FakeTeamsRunner {
  enqueueCalls: Array<{ agentId: string; teamId: string }> = [];
  /** agentId -> in-flight teamId, mirroring the real runner's `inFlight` map. */
  running = new Map<string, string>();
  /** When set, enqueue rejects with it (and registers nothing in-flight). */
  enqueueError: Error | undefined;
  /** When set, enqueue RESOLVES with it instead of staying pending. Models
   *  the real runner's refusal, which is a resolved `{status:'rejected'}`
   *  value and NOT a rejected promise — the shape a `.catch()`-only caller
   *  silently drops. */
  enqueueResult: unknown | undefined;

  enqueue(request: { agentId: string; teamId: string }): Promise<unknown> {
    this.enqueueCalls.push({ ...request });
    if (this.enqueueError) return Promise.reject(this.enqueueError);
    if (this.enqueueResult !== undefined) {
      return Promise.resolve(this.enqueueResult);
    }
    // Mirrors the real runner: a successful enqueue synchronously holds an
    // in-flight run, so the POST's `running` flag reads true.
    this.running.set(request.agentId, request.teamId);
    return new Promise<unknown>(() => {});
  }
  isRunning(agentId: string): boolean {
    return this.running.has(agentId);
  }
  runningTeamId(agentId: string): string | null {
    return this.running.get(agentId) ?? null;
  }
}

/** Poll a predicate until it holds. The routes start a provisioning run
 *  WITHOUT awaiting it, so anything the outcome handler records lands a
 *  microtask (or more) after the response. */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: predicate never became true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeRegistry {
  reloadCalls = 0;
  invalidateCalls: Array<{ slug: string; mode: 'drain' | 'kill' }> = [];

  list() {
    return [];
  }
  get(slug: string) {
    return { memoryScope: [`agent:fake:${slug}:*`, 'core'] };
  }
  reload(): Promise<{ actions: unknown[]; platformChanged: boolean }> {
    this.reloadCalls += 1;
    return Promise.resolve({ actions: [], platformChanged: false });
  }
  forceInvalidate(slug: string, mode: 'drain' | 'kill'): Promise<number> {
    this.invalidateCalls.push({ slug, mode });
    return Promise.resolve(2);
  }
}

describe('createOperatorAgentsRouter', () => {
  let server: Server;
  let baseUrl: string;
  let store: FakeConfigStore;
  let registry: FakeRegistry;
  let graph: FakeGraphStore;
  let sessionStore: { list: () => Promise<unknown[]> };
  let teamsStore: FakeTeamsIdentityStore;
  let teamsRunner: FakeTeamsRunner;
  let provisionerInstalled: boolean;
  /** #900 — the accessor the route feature-detects on. `undefined` models a
   *  connector that is not installed at all. */
  let provisioner: FakeTeamsProvisioner | LegacyTeamsProvisioner | undefined;
  /** #910 — the installed registry the `teams_bots_sync` projection reads.
   *  `undefined` by default so every pre-existing test keeps the exact mount
   *  it was written against; the sync tests below bind it per case. */
  let installedPlugins: InstalledRegistry | undefined;
  /** Migration 0051 — `undefined` keeps the pre-0051 contract every existing
   *  case pins; the multi-team cases bind it per test. */
  let teamsInstalls: FakeTeamsInstallStore | undefined;
  /** Team-name resolver the route backfills from. `undefined` models a
   *  connector below 0.5.0, which has no `getTeam`. */
  let resolveTeamName: ((teamId: string) => Promise<string | null>) | undefined;
  /** Migration 0053 — `undefined` keeps the pre-0053 response shape every
   *  existing case pins; the timeline cases bind it per test. */
  let teamsEvents: FakeTeamsEventStore | undefined;

  before(async () => {
    store = new FakeConfigStore();
    registry = new FakeRegistry();
    graph = new FakeGraphStore();
    sessionStore = { list: () => Promise.resolve([]) };
    teamsStore = new FakeTeamsIdentityStore();
    teamsRunner = new FakeTeamsRunner();
    provisionerInstalled = true;
    provisioner = new FakeTeamsProvisioner();
    installedPlugins = undefined;
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/operator/agents',
      createOperatorAgentsRouter({
        getConfigStore: () => store as unknown as ConfigStore,
        getRegistry: () => registry as unknown as OrchestratorRegistry,
        getChatSessionStore: () => sessionStore as unknown as ChatSessionStore,
        getAgentGraphStore: () => graph as unknown as AgentGraphStore,
        // #910 — read live, like every other getter here.
        getInstalledRegistry: () => installedPlugins,
        // W1a (#860) — getters read the CURRENT fakes so afterEach resets apply.
        getTeamsIdentity: () => ({
          store: teamsStore,
          runner: teamsRunner,
          isProvisionerInstalled: () => provisionerInstalled,
          getProvisioner: () =>
            provisioner as unknown as TeamsProvisionerAccessor | undefined,
          ...(teamsInstalls === undefined ? {} : { installs: teamsInstalls }),
          ...(resolveTeamName === undefined ? {} : { resolveTeamName }),
          ...(teamsEvents === undefined ? {} : { events: teamsEvents }),
        }),
      }),
    );
    server = await listenLoopback(app);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/api/v1/operator/agents`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  afterEach(() => {
    store = new FakeConfigStore();
    graph = new FakeGraphStore();
    registry.reloadCalls = 0;
    registry.invalidateCalls = [];
    teamsStore = new FakeTeamsIdentityStore();
    teamsRunner = new FakeTeamsRunner();
    provisionerInstalled = true;
    provisioner = new FakeTeamsProvisioner();
    installedPlugins = undefined;
    teamsInstalls = undefined;
    resolveTeamName = undefined;
    teamsEvents = undefined;
  });

  // ── W5 memory-ACL rollout switch (#899) ─────────────────────────────
  describe('context-memory rollout switch (#899)', () => {
    it('GET /:slug/context-memory defaults to off and advertises the union', async () => {
      await store.createAgent({ slug: 'public', name: 'Public' });
      const res = await fetch(`${baseUrl}/public/context-memory`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        slug: string;
        mode: string;
        modes: string[];
      };
      assert.equal(body.slug, 'public');
      assert.equal(body.mode, 'off');
      // The UI renders its radio group from this list, so the route owns the
      // union. A drift here would silently drop a mode from the operator's
      // choices while the runtime still honours it.
      assert.deepEqual(body.modes, ['off', 'enforce', 'enforce-strict']);
    });

    it('GET /:slug/context-memory reads an unknown persisted value as off', async () => {
      const agent = await store.createAgent({ slug: 'public', name: 'Public' });
      // A value written by a NEWER middleware during a rolling deploy, or by
      // hand. Deny-default: the operator must not see "on" for a mode this
      // process would route as off.
      store.agents.set(agent.id, {
        ...agent,
        contextMemory: 'enforce-super-strict' as never,
      });
      const res = await fetch(`${baseUrl}/public/context-memory`);
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { mode: string }).mode, 'off');
    });

    it('GET /:slug/context-memory 404s for an unknown agent', async () => {
      const res = await fetch(`${baseUrl}/nope/context-memory`);
      assert.equal(res.status, 404);
      assert.equal(((await res.json()) as { error: string }).error, 'not_found');
    });

    it('PUT /:slug/context-memory persists the mode and triggers a reload', async () => {
      await store.createAgent({ slug: 'public', name: 'Public' });
      const res = await fetch(`${baseUrl}/public/context-memory`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'enforce' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, mode: 'enforce' });
      assert.equal((await store.getAgentBySlug('public'))?.contextMemory, 'enforce');
      // Without the reload the switch would only take effect on the next
      // process restart, which is the shape of bug that reads as "it did
      // nothing" in production.
      assert.equal(registry.reloadCalls, 1);
    });

    it('PUT /:slug/context-memory accepts enforce-strict and switches back to off', async () => {
      await store.createAgent({ slug: 'public', name: 'Public' });
      for (const mode of ['enforce-strict', 'off'] as const) {
        const res = await fetch(`${baseUrl}/public/context-memory`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode }),
        });
        assert.equal(res.status, 200);
        assert.equal((await store.getAgentBySlug('public'))?.contextMemory, mode);
      }
    });

    it('PUT /:slug/context-memory rejects a mode outside the union with 400', async () => {
      await store.createAgent({ slug: 'public', name: 'Public' });
      const res = await fetch(`${baseUrl}/public/context-memory`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'enforce-ish' }),
      });
      assert.equal(res.status, 400);
      assert.equal(((await res.json()) as { error: string }).error, 'invalid_body');
      // Rejected, not coerced: an agent left untouched is auditable, an agent
      // silently reset to `off` while the UI shows `enforce` is not.
      assert.equal((await store.getAgentBySlug('public'))?.contextMemory, undefined);
      assert.equal(registry.reloadCalls, 0);
    });

    it('PUT /:slug/context-memory 404s for an unknown agent and writes nothing', async () => {
      const res = await fetch(`${baseUrl}/nope/context-memory`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'enforce' }),
      });
      assert.equal(res.status, 404);
      assert.equal(registry.reloadCalls, 0);
    });

    it('PATCH /:slug leaves an enforcing agent enforcing', async () => {
      // The dashboard's rename/enable form sends whatever it holds. It must
      // not be able to carry a memory-scope change along with a rename.
      const agent = await store.createAgent({ slug: 'public', name: 'Public' });
      store.agents.set(agent.id, { ...agent, contextMemory: 'enforce' });
      const res = await fetch(`${baseUrl}/public`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });
      assert.equal(res.status, 200);
      const after = await store.getAgentBySlug('public');
      assert.equal(after?.name, 'Renamed');
      assert.equal(after?.contextMemory, 'enforce');
    });

    it('the advertised union matches the CHECK constraint in migration 0050', async () => {
      // The column's CHECK is the last line of defence. If the route offered a
      // fourth mode, the write would fail at the database with a 500 instead
      // of a validation error — so the two unions are pinned to each other.
      const sql = await readFile(
        new URL('../migrations/0050_agent_context_memory_flag.sql', import.meta.url),
        'utf8',
      );
      const match = /context_memory\s+IN\s*\(([^)]*)\)/.exec(sql);
      assert.ok(match, 'migration 0050 must CHECK context_memory against a value list');
      const fromSql = [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      assert.deepEqual(fromSql, [...CONTEXT_MEMORY_MODES]);
    });
  });

  it('POST / creates an agent and triggers a reload', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'public', name: 'Public Agent' }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { slug: string };
    assert.equal(body.slug, 'public');
    assert.equal(registry.reloadCalls, 1);
  });

  it('POST / surfaces a Zod validation error as HTTP 400', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: '', name: 'x' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    assert.equal(body.error, 'invalid_body');
    assert.ok(Array.isArray(body.issues));
  });

  it('POST / surfaces a ConfigValidationError as HTTP 409', async () => {
    await store.createAgent({ slug: 'pub', name: 'Pub' });
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'pub', name: 'Dup' }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'config_validation');
  });

  it('GET / returns the agent list with runtime memory_scope', async () => {
    await store.createAgent({ slug: 'public', name: 'Public' });
    const res = await fetch(baseUrl);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      agents: Array<{ slug: string; memory_scope: string[] }>;
    };
    assert.equal(body.agents.length, 1);
    assert.equal(body.agents[0]!.slug, 'public');
    assert.deepEqual(body.agents[0]!.memory_scope, [
      'agent:fake:public:*',
      'core',
    ]);
  });

  it('PATCH /:slug updates status and triggers a reload', async () => {
    await store.createAgent({ slug: 'public', name: 'Public' });
    const res = await fetch(`${baseUrl}/public`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    assert.equal(res.status, 200);
    const agent = await store.getAgentBySlug('public');
    assert.equal(agent?.status, 'disabled');
    assert.equal(registry.reloadCalls, 1);
  });

  it('DELETE /:slug removes the agent', async () => {
    await store.createAgent({ slug: 'public', name: 'Public' });
    const res = await fetch(`${baseUrl}/public`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(await store.getAgentBySlug('public'), undefined);
  });

  it('PATCH /:slug refuses to DISABLE the fallback orchestrator (409 fallback_protected)', async () => {
    await store.createAgent({ slug: 'fallback', name: 'Standard Orchestrator' });
    const res = await fetch(`${baseUrl}/fallback`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: string }).error, 'fallback_protected');
    assert.equal((await store.getAgentBySlug('fallback'))?.status, 'enabled', 'stayed enabled');
  });

  it('PATCH /:slug still allows ENABLING / renaming the fallback orchestrator', async () => {
    await store.createAgent({ slug: 'fallback', name: 'Standard Orchestrator' });
    const res = await fetch(`${baseUrl}/fallback`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'enabled', name: 'Renamed' }),
    });
    assert.equal(res.status, 200, 'only disable/delete are blocked');
  });

  it('DELETE /:slug refuses to delete the fallback orchestrator (409 fallback_protected)', async () => {
    await store.createAgent({ slug: 'fallback', name: 'Standard Orchestrator' });
    const res = await fetch(`${baseUrl}/fallback`, { method: 'DELETE' });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: string }).error, 'fallback_protected');
    assert.ok(await store.getAgentBySlug('fallback'), 'not deleted');
  });

  it('protects whatever the platform fallbackAgentId points at (id-based, non-"fallback" slug)', async () => {
    const agent = await store.createAgent({ slug: 'special', name: 'Special' });
    await store.setFallbackAgentId(agent.id);
    const res = await fetch(`${baseUrl}/special`, { method: 'DELETE' });
    assert.equal(res.status, 409, 'active platform fallback protected by id');
    assert.equal(((await res.json()) as { error: string }).error, 'fallback_protected');
  });

  it('PUT /:slug/plugins replaces the plugin set', async () => {
    const agent = await store.createAgent({ slug: 'public', name: 'Public' });
    await store.upsertAgentPlugin(agent.id, { pluginId: '@omadia/old' });
    const res = await fetch(`${baseUrl}/public/plugins`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        plugins: [
          { id: '@omadia/a', enabled: true },
          { id: '@omadia/b', enabled: false },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const remaining = await store.listAgentPlugins(agent.id);
    const ids = remaining.map((p) => p.pluginId).sort();
    assert.deepEqual(ids, ['@omadia/a', '@omadia/b']);
  });

  it('GET /:slug/plugins reads the assignment (W0c #861)', async () => {
    const agent = await store.createAgent({ slug: 'public', name: 'Public' });
    await store.upsertAgentPlugin(agent.id, {
      pluginId: '@omadia/odoo',
      config: { url: 'https://odoo.example' },
      enabled: true,
    });
    await store.upsertAgentPlugin(agent.id, {
      pluginId: '@omadia/confluence',
      enabled: false,
    });
    const res = await fetch(`${baseUrl}/public/plugins`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      slug: string;
      fallback: boolean;
      plugins: Array<{ id: string; config: Record<string, unknown>; enabled: boolean }>;
    };
    assert.equal(body.slug, 'public');
    assert.equal(body.fallback, false);
    const byId = new Map(body.plugins.map((p) => [p.id, p]));
    assert.equal(byId.size, 2);
    assert.deepEqual(byId.get('@omadia/odoo')?.config, { url: 'https://odoo.example' });
    assert.equal(byId.get('@omadia/odoo')?.enabled, true);
    assert.equal(byId.get('@omadia/confluence')?.enabled, false);
  });

  it('GET /:slug/plugins 404s for an unknown agent', async () => {
    const res = await fetch(`${baseUrl}/ghost/plugins`);
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: string }).error, 'not_found');
  });

  it('PATCH /:slug/plugins disables ONE plugin, preserves its config, reloads', async () => {
    const agent = await store.createAgent({ slug: 'public', name: 'Public' });
    await store.upsertAgentPlugin(agent.id, {
      pluginId: '@omadia/odoo',
      config: { url: 'https://odoo.example' },
      enabled: true,
    });
    const res = await fetch(`${baseUrl}/public/plugins`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '@omadia/odoo', enabled: false }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      plugin: { id: string; enabled: boolean };
    };
    assert.equal(body.ok, true);
    assert.deepEqual(body.plugin, { id: '@omadia/odoo', enabled: false });
    const rows = await store.listAgentPlugins(agent.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.enabled, false);
    assert.deepEqual(
      rows[0]!.config,
      { url: 'https://odoo.example' },
      'toggle must not wipe the per-agent config',
    );
    assert.equal(registry.reloadCalls, 1);
  });

  it('PATCH /:slug/plugins with enabled=true assigns a not-yet-assigned plugin', async () => {
    const agent = await store.createAgent({ slug: 'public', name: 'Public' });
    const res = await fetch(`${baseUrl}/public/plugins`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '@omadia/fresh', enabled: true }),
    });
    assert.equal(res.status, 200);
    const rows = await store.listAgentPlugins(agent.id);
    assert.deepEqual(
      rows.map((p) => ({ id: p.pluginId, enabled: p.enabled })),
      [{ id: '@omadia/fresh', enabled: true }],
    );
  });

  it('PATCH /:slug/plugins with enabled=false on an unassigned plugin → 404 plugin_not_assigned', async () => {
    await store.createAgent({ slug: 'public', name: 'Public' });
    const res = await fetch(`${baseUrl}/public/plugins`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '@omadia/ghost', enabled: false }),
    });
    assert.equal(res.status, 404);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      'plugin_not_assigned',
    );
    assert.equal(registry.reloadCalls, 0, 'no reload on a rejected toggle');
  });

  it('PATCH /:slug/plugins keeps the fallback agent on the global config ({})', async () => {
    const agent = await store.createAgent({ slug: 'special', name: 'Special' });
    await store.setFallbackAgentId(agent.id);
    await store.upsertAgentPlugin(agent.id, {
      pluginId: '@omadia/odoo',
      config: { smuggled: true },
      enabled: true,
    });
    const res = await fetch(`${baseUrl}/special/plugins`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '@omadia/odoo', enabled: false }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { fallback: boolean }).fallback, true);
    const rows = await store.listAgentPlugins(agent.id);
    assert.deepEqual(
      rows[0]!.config,
      {},
      'fallback Agent always runs plugins with the global store config',
    );
  });

  it('GET /:slug/grants returns tool grants + plugin MCP grants + grant epoch (W0c #861)', async () => {
    const agent = await store.createAgent({ slug: 'public', name: 'Public' });
    const other = await store.createAgent({ slug: 'other', name: 'Other' });
    await store.upsertAgentPlugin(agent.id, { pluginId: '@omadia/odoo' });
    graph.servers = [{ id: 'srv-1', name: 'odoo-mcp' }];
    graph.toolGrants = [
      {
        id: 'g-1',
        agentId: agent.id,
        subAgentId: null,
        toolKind: 'mcp',
        toolRef: 'mcp:odoo-mcp:search',
        mcpServerId: 'srv-1',
        config: {},
        createdAt: new Date('2026-08-01T00:00:00Z'),
        grantEpoch: '2026-08-20 10:00:00+00',
      },
      {
        id: 'g-2',
        agentId: agent.id,
        subAgentId: null,
        toolKind: 'builtin',
        toolRef: 'web_search',
        mcpServerId: null,
        config: {},
        createdAt: new Date('2026-08-02T00:00:00Z'),
        grantEpoch: '2026-08-21 09:30:00+00',
      },
      {
        id: 'g-3',
        agentId: other.id,
        subAgentId: null,
        toolKind: 'mcp',
        toolRef: 'mcp:odoo-mcp:write',
        mcpServerId: 'srv-1',
        config: {},
        createdAt: new Date('2026-08-03T00:00:00Z'),
        grantEpoch: null,
      },
    ];
    graph.pluginGrants = [
      {
        pluginId: '@omadia/odoo',
        mcpServerId: 'srv-1',
        grantedBy: 'operator',
        grantedAt: new Date('2026-08-10T00:00:00Z'),
      },
      {
        pluginId: '@omadia/unassigned',
        mcpServerId: 'srv-1',
        grantedBy: 'operator',
        grantedAt: new Date('2026-08-11T00:00:00Z'),
      },
    ];
    const res = await fetch(`${baseUrl}/public/grants`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      slug: string;
      grant_epoch: string | null;
      tool_grants: Array<{
        id: string;
        server_name: string | null;
        grant_epoch: string | null;
      }>;
      plugin_mcp_grants: Array<{ plugin_id: string; server_name: string | null }>;
    };
    assert.equal(body.slug, 'public');
    assert.equal(body.grant_epoch, '2026-08-21 09:30:00+00', 'latest bump wins');
    assert.deepEqual(
      body.tool_grants.map((g) => g.id),
      ['g-1', 'g-2'],
      'only the agent\'s own grants',
    );
    assert.equal(body.tool_grants[0]!.server_name, 'odoo-mcp');
    assert.equal(body.tool_grants[0]!.grant_epoch, '2026-08-20 10:00:00+00');
    assert.deepEqual(
      body.plugin_mcp_grants.map((g) => g.plugin_id),
      ['@omadia/odoo'],
      'plugin grants scoped to the plugins assigned to THIS agent',
    );
    assert.equal(body.plugin_mcp_grants[0]!.server_name, 'odoo-mcp');
  });

  it('GET /:slug/grants includes grants held by the agent\'s SUB-agents, attributed via sub_agent_id (W0c)', async () => {
    // agent_tool_grants is a XOR table: a sub-agent-held grant has agent_id
    // NULL. Hiding those rows made the detail page claim "no grants" while
    // the sub-agent could reach the server (the W0c review's failing state).
    const agent = await store.createAgent({ slug: 'public', name: 'Public' });
    const other = await store.createAgent({ slug: 'other', name: 'Other' });
    graph.servers = [{ id: 'srv-1', name: 'odoo-mcp' }];
    graph.subAgentsOf = { [agent.id]: ['sa-researcher'], [other.id]: ['sa-foreign'] };
    graph.toolGrants = [
      {
        id: 'g-sub',
        agentId: null,
        subAgentId: 'sa-researcher',
        toolKind: 'mcp',
        toolRef: 'odoo-mcp:search',
        mcpServerId: 'srv-1',
        config: {},
        createdAt: new Date('2026-08-01T00:00:00Z'),
        grantEpoch: '2026-08-22 08:00:00+00',
      },
      {
        id: 'g-foreign',
        agentId: null,
        subAgentId: 'sa-foreign',
        toolKind: 'mcp',
        toolRef: 'odoo-mcp:write',
        mcpServerId: 'srv-1',
        config: {},
        createdAt: new Date('2026-08-02T00:00:00Z'),
        grantEpoch: null,
      },
    ];
    const res = await fetch(`${baseUrl}/public/grants`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      grant_epoch: string | null;
      tool_grants: Array<{ id: string; sub_agent_id: string | null; tool_ref: string }>;
    };
    assert.deepEqual(
      body.tool_grants.map((g) => g.id),
      ['g-sub'],
      "own sub-agents' grants in, other agents' sub-agents out",
    );
    assert.equal(body.tool_grants[0]!.sub_agent_id, 'sa-researcher');
    assert.equal(
      body.grant_epoch,
      '2026-08-22 08:00:00+00',
      'a sub-agent grant epoch counts toward the agent-level max',
    );
  });

  it('GET /:slug/grants normalizes a serverName-prefixed mcp tool_ref to the bare tool name (W0c)', async () => {
    // Stored refs may carry the '<serverName>:' prefix (canvas edges persist
    // the caller's raw ref). Every other reader normalizes via
    // mcpToolNameFromRef; the read model must too, so the UI can compare
    // tool_ref against discoveredTools[].name verbatim.
    const agent = await store.createAgent({ slug: 'public', name: 'Public' });
    graph.servers = [{ id: 'srv-1', name: 'odoo-mcp' }];
    graph.toolGrants = [
      {
        id: 'g-prefixed',
        agentId: agent.id,
        subAgentId: null,
        toolKind: 'mcp',
        toolRef: 'odoo-mcp:search_partners',
        mcpServerId: 'srv-1',
        config: {},
        createdAt: new Date('2026-08-01T00:00:00Z'),
        grantEpoch: null,
      },
      {
        id: 'g-native',
        agentId: agent.id,
        subAgentId: null,
        toolKind: 'native',
        toolRef: 'memory:search', // native refs are NOT server-prefixed — stay verbatim
        mcpServerId: null,
        config: {},
        createdAt: new Date('2026-08-02T00:00:00Z'),
        grantEpoch: null,
      },
    ];
    const res = await fetch(`${baseUrl}/public/grants`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tool_grants: Array<{ id: string; tool_ref: string }> };
    assert.equal(body.tool_grants[0]!.tool_ref, 'search_partners');
    assert.equal(body.tool_grants[1]!.tool_ref, 'memory:search');
  });

  it('index.ts supplies getAgentGraphStore to the operator-agents mount (wiring pin, W0c)', async () => {
    // The route tests above inject their own store; they cannot see a missing
    // option at the REAL mount. That exact gap shipped once: index.ts called
    // createOperatorAgentsRouter without getAgentGraphStore and every
    // /grants request 503ed in every environment (W0c review blocker). Pin
    // the wiring statically so the option cannot silently disappear again.
    const indexSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    const mount = /createOperatorAgentsRouter\(\{([\s\S]*?)\}\)/.exec(indexSource)?.[1];
    assert.ok(mount, 'index.ts no longer mounts createOperatorAgentsRouter — update this pin');
    assert.match(
      mount,
      /getAgentGraphStore:/,
      'index.ts must pass getAgentGraphStore to createOperatorAgentsRouter — without it every GET /:slug/grants 503s',
    );
    assert.match(mount, /new AgentGraphStore\(graphPool\)/, 'the option must construct the real store from graphPool');
  });

  it('index.ts wires syncBotConfig into the provisioning runner (wiring pin, #910)', async () => {
    // The runner treats a missing sync port as "the operator configures
    // channel-teams by hand" — exactly the pre-#910 behaviour, and exactly the
    // regression a unit test with an injected port cannot see. Pin the real
    // boot wiring instead.
    const indexSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    const runner = /new TeamsProvisioningJobRunner\(\{([\s\S]*?)\n    \}\)/.exec(
      indexSource,
    )?.[1];
    assert.ok(
      runner,
      'index.ts no longer constructs TeamsProvisioningJobRunner — update this pin',
    );
    assert.match(
      runner,
      /syncBotConfig:/,
      'index.ts must pass syncBotConfig to TeamsProvisioningJobRunner — without it a provisioned bot stays unconfigured until an operator pastes the block by hand',
    );
    assert.match(
      runner,
      /syncTeamsBotConfig\(/,
      'the port must delegate to services/teamsBotsConfigSync.ts, not re-implement the write',
    );
    assert.match(
      runner,
      /reactivate: reactivateAgent/,
      'the sync must reload the plugin through the same funnel every other live config change uses',
    );
  });

  it('index.ts supplies getTeamsIdentity to the operator-agents mount (wiring pin, W1a #860)', async () => {
    // Same rationale as the getAgentGraphStore pin above: the route tests
    // inject their own deps and cannot see a missing option at the REAL
    // mount. Pin the wiring statically so the teams-identity routes cannot
    // silently degrade to a permanent 503.
    const indexSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    const mount = /createOperatorAgentsRouter\(\{([\s\S]*?)\}\)/.exec(indexSource)?.[1];
    assert.ok(mount, 'index.ts no longer mounts createOperatorAgentsRouter — update this pin');
    assert.match(
      mount,
      /getTeamsIdentity:/,
      'index.ts must pass getTeamsIdentity to createOperatorAgentsRouter — without it every /:slug/teams-identity request 503s',
    );
    assert.match(
      mount,
      /'agentTeamsIdentityStore'/,
      'the option must resolve the identity store through the service registry',
    );
    assert.match(
      mount,
      /'teamsProvisioningJobRunner'/,
      'the option must resolve the provisioning job runner through the service registry',
    );
    assert.match(
      mount,
      /serviceRegistry\.has\('teamsProvisioner'\)/,
      'provisioner availability must come live from the service registry',
    );
  });

  it('GET /:slug/grants → grant_epoch null when no grant was ever bumped', async () => {
    const agent = await store.createAgent({ slug: 'public', name: 'Public' });
    graph.toolGrants = [
      {
        id: 'g-1',
        agentId: agent.id,
        subAgentId: null,
        toolKind: 'builtin',
        toolRef: 'web_search',
        mcpServerId: null,
        config: {},
        createdAt: new Date(),
        grantEpoch: null,
      },
    ];
    const res = await fetch(`${baseUrl}/public/grants`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { grant_epoch: string | null };
    assert.equal(body.grant_epoch, null);
  });

  it('GET /:slug/grants 503s when no agent graph store is wired', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/operator/agents',
      createOperatorAgentsRouter({
        getConfigStore: () => store as unknown as ConfigStore,
        getRegistry: () => registry as unknown as OrchestratorRegistry,
        getChatSessionStore: () => sessionStore as unknown as ChatSessionStore,
      }),
    );
    const s = await listenLoopback(app);
    try {
      await store.createAgent({ slug: 'public', name: 'Public' });
      const addr = s.address() as AddressInfo;
      const res = await fetch(
        `http://127.0.0.1:${String(addr.port)}/api/v1/operator/agents/public/grants`,
      );
      assert.equal(res.status, 503);
      assert.equal(
        ((await res.json()) as { error: string }).error,
        'agent_graph_store_unavailable',
      );
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  // ── #915: the provisioning timeline on the status endpoint ──────────
  //
  // The five persisted chain states say WHERE a run is; these events say what
  // it has been doing between them, which is where the minutes go. The field
  // is ADDITIVE — every assertion below also has to leave the rest of the
  // envelope exactly as the pre-0053 cases above pin it.

  describe('provisioning timeline (#915)', () => {
    function event(overrides: Record<string, unknown> = {}): {
      id: string;
      agentId: string;
      at: Date;
      step: string;
      status: string;
      attempt: number | null;
      detail: string | null;
    } {
      return {
        id: '1',
        agentId: 'agent-id',
        at: new Date('2026-08-28T10:00:00.000Z'),
        step: 'app_registered',
        status: 'started',
        attempt: null,
        detail: null,
        ...overrides,
      } as ReturnType<typeof event>;
    }

    it('GET /:slug/teams-identity publishes the run timeline, newest first', async () => {
      const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
      teamsStore.rows.set(agent.id, {
        agentId: agent.id,
        botSlug: 'sales',
        displayName: 'Sales',
        state: 'bot_created',
        teamId: 'aaaaaaaa-0000-4000-8000-000000000001',
        appId: 'app-1',
        tenantId: 'tenant-1',
        teamsAppId: null,
        teamsAppExternalId: null,
        lastError: null,
      });
      const events = new FakeTeamsEventStore();
      // Newest first, as the store returns them (ORDER BY id DESC).
      events.rows = [
        event({
          id: '3',
          agentId: agent.id,
          step: 'bot_created',
          status: 'retrying',
          attempt: 2,
          detail: 'retry_in_ms=2000;max_attempts=5',
        }),
        event({ id: '2', agentId: agent.id, step: 'bot_created' }),
        event({ id: '1', agentId: agent.id, status: 'succeeded' }),
      ];
      teamsEvents = events;

      const res = await fetch(`${baseUrl}/sales/teams-identity`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        state: string;
        provisioning_events: Array<{
          id: string;
          at: string;
          step: string;
          status: string;
          attempt: number | null;
          detail: string | null;
        }>;
        identity: { bot_slug: string };
      };

      assert.deepEqual(
        body.provisioning_events.map((e) => `${e.step}/${e.status}`),
        ['bot_created/retrying', 'bot_created/started', 'app_registered/succeeded'],
      );
      // The two numbers the operator copy is built from have to survive the
      // wire as structured values, not as an English sentence.
      assert.equal(body.provisioning_events[0]?.attempt, 2);
      assert.equal(
        body.provisioning_events[0]?.detail,
        'retry_in_ms=2000;max_attempts=5',
      );
      // `at` is an ISO string, like every other timestamp in this envelope.
      assert.equal(
        body.provisioning_events[0]?.at,
        '2026-08-28T10:00:00.000Z',
      );
      // Additive: the pre-0053 payload is untouched.
      assert.equal(body.state, 'bot_created');
      assert.equal(body.identity.bot_slug, 'sales');
      // The endpoint bounds what it publishes — a status poll every 3s per
      // open panel must not turn into a page of JSON.
      assert.equal(events.lastLimit, 30);
    });

    it('reports an empty timeline on a mount without the events store (pre-0053)', async () => {
      const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
      teamsStore.rows.set(agent.id, {
        agentId: agent.id,
        botSlug: 'sales',
        displayName: 'Sales',
        state: 'pending',
        teamId: null,
        appId: null,
        tenantId: null,
        teamsAppId: null,
        teamsAppExternalId: null,
        lastError: null,
      });

      const res = await fetch(`${baseUrl}/sales/teams-identity`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { provisioning_events: unknown[] };
      assert.deepEqual(body.provisioning_events, []);
    });

    it('still answers the identity when the timeline cannot be read', async () => {
      // The timeline is decoration on a response whose real payload is the
      // identity row. A middleware below migration 0053, an unreadable table,
      // a query that timed out — none of them are a reason to deny an
      // operator the state of their agent.
      const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
      teamsStore.rows.set(agent.id, {
        agentId: agent.id,
        botSlug: 'sales',
        displayName: 'Sales',
        state: 'installed',
        teamId: 'aaaaaaaa-0000-4000-8000-000000000001',
        appId: 'app-1',
        tenantId: 'tenant-1',
        teamsAppId: 'catalog-1',
        teamsAppExternalId: 'ext-1',
        lastError: null,
      });
      const events = new FakeTeamsEventStore();
      events.readError = new Error('relation does not exist');
      teamsEvents = events;

      const res = await fetch(`${baseUrl}/sales/teams-identity`);
      assert.equal(res.status, 200, 'a broken timeline must not 500 the status');
      const body = (await res.json()) as {
        state: string;
        provisioning_events: unknown[];
      };
      assert.equal(body.state, 'installed');
      assert.deepEqual(body.provisioning_events, []);
    });

    it('never reports a terminally failed identity as still running (#915)', async () => {
      // The route publishes the RUNNER's answer verbatim — the honest-running
      // fix lives in `TeamsProvisioningJobRunner.isRunning`, and is pinned
      // there. What this pins is the half the route owns: it must not
      // manufacture a `true` of its own, and it must not paper over a `true`
      // either (see the next case).
      const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
      teamsStore.rows.set(agent.id, {
        agentId: agent.id,
        botSlug: 'sales',
        displayName: 'Sales',
        state: 'failed',
        teamId: 'aaaaaaaa-0000-4000-8000-000000000001',
        appId: 'app-1',
        tenantId: 'tenant-1',
        teamsAppId: null,
        teamsAppExternalId: null,
        lastError: 'consent_missing: admin consent required for scopes []',
      });
      // Nothing in flight — the runner has settled and released the run.
      teamsRunner.running.clear();

      const res = await fetch(`${baseUrl}/sales/teams-identity`);
      const body = (await res.json()) as { state: string; running: boolean };
      assert.equal(body.state, 'failed');
      assert.equal(
        body.running,
        false,
        'a terminal verdict must never be presented as work in progress',
      );
    });

    it('keeps reporting a genuine re-run of a failed row as running', async () => {
      // The tempting "fix" for #915 is to suppress `running` whenever the row
      // is terminal. It is wrong, and this is why: a re-run IS running before
      // it writes its first state, and since migration 0051 an `installed`
      // agent can legitimately be provisioning into a second team. Both would
      // read as idle, and the panel would stop polling a live run.
      const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
      teamsStore.rows.set(agent.id, {
        agentId: agent.id,
        botSlug: 'sales',
        displayName: 'Sales',
        state: 'failed',
        teamId: 'aaaaaaaa-0000-4000-8000-000000000001',
        appId: 'app-1',
        tenantId: 'tenant-1',
        teamsAppId: null,
        teamsAppExternalId: null,
        lastError: 'consent_missing: admin consent required for scopes []',
      });
      teamsRunner.running.set(agent.id, 'aaaaaaaa-0000-4000-8000-000000000001');

      const res = await fetch(`${baseUrl}/sales/teams-identity`);
      const body = (await res.json()) as { state: string; running: boolean };
      assert.equal(body.state, 'failed');
      assert.equal(
        body.running,
        true,
        'a run the runner actually holds must be reported, terminal row or not',
      );
    });
  });

  // ── W1a (#860): Teams identity provisioning endpoints ───────────────

  it('POST /:slug/teams-identity ensures the row, enqueues, and answers 202 without awaiting the run', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales Agent' });
    const res = await fetch(`${baseUrl}/sales/teams-identity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: 'abcabcab-0000-4000-8000-000000000003' }),
    });
    // FakeTeamsRunner.enqueue never settles — reaching these assertions at
    // all proves the handler returned without awaiting the provisioning run.
    assert.equal(res.status, 202);
    const body = (await res.json()) as {
      ok: boolean;
      agent: string;
      bot_slug: string;
      state: string;
      running: boolean;
    };
    assert.equal(body.ok, true);
    assert.equal(body.agent, 'sales');
    assert.equal(body.bot_slug, 'sales');
    assert.equal(body.state, 'pending');
    assert.equal(body.running, true);
    assert.deepEqual(teamsRunner.enqueueCalls, [
      {
        agentId: agent.id,
        teamId: 'abcabcab-0000-4000-8000-000000000003',
        targetKind: 'team',
      },
    ]);
    assert.equal(teamsStore.rows.size, 1);
    assert.deepEqual(teamsStore.ensureCalls, [
      {
        agentId: agent.id,
        botSlug: 'sales',
        displayName: 'Sales Agent',
        teamId: 'abcabcab-0000-4000-8000-000000000003',
        targetKind: 'team',
      },
    ]);
  });

  it('POST /:slug/teams-identity derives a URL-safe bot slug and honors overrides on first creation', async () => {
    await store.createAgent({ slug: 'My_Sales.Agent', name: 'Sales' });
    const res = await fetch(
      `${baseUrl}/${encodeURIComponent('My_Sales.Agent')}/teams-identity`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          team_id: '11111111-0000-4000-8000-000000000004',
          display_name: 'Sales Bot',
        }),
      },
    );
    assert.equal(res.status, 202);
    const body = (await res.json()) as { bot_slug: string };
    assert.equal(body.bot_slug, 'my-sales-agent', 'sanitized from the agent slug');
    assert.equal(teamsStore.ensureCalls[0]!.displayName, 'Sales Bot');
  });

  it('POST /:slug/teams-identity is create-or-provision: one identity per agent, a re-POST reuses the row', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    const first = await fetch(`${baseUrl}/sales/teams-identity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: '11111111-0000-4000-8000-000000000004', bot_slug: 'sales-bot' }),
    });
    assert.equal(first.status, 202);
    const second = await fetch(`${baseUrl}/sales/teams-identity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: '11111111-0000-4000-8000-000000000004', bot_slug: 'other-bot' }),
    });
    assert.equal(second.status, 202);
    const body = (await second.json()) as { bot_slug: string };
    assert.equal(body.bot_slug, 'sales-bot', 'existing row wins over the re-POST');
    assert.equal(teamsStore.rows.size, 1, 'unique agent_id — no second row');
    assert.equal(teamsRunner.enqueueCalls.length, 2, 're-POST re-runs provisioning');
    assert.equal(teamsRunner.enqueueCalls[1]!.agentId, agent.id);
  });

  it('POST /:slug/teams-identity → 404 for an unknown agent, 400 without team_id', async () => {
    let res = await fetch(`${baseUrl}/ghost/teams-identity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: '11111111-0000-4000-8000-000000000004' }),
    });
    assert.equal(res.status, 404);

    await store.createAgent({ slug: 'sales', name: 'Sales' });
    res = await fetch(`${baseUrl}/sales/teams-identity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'invalid_body');
    assert.equal(teamsRunner.enqueueCalls.length, 0, 'nothing enqueued');
  });

  it('POST /:slug/teams-identity 503s when teamsProvisioner@1 is not installed', async () => {
    provisionerInstalled = false;
    await store.createAgent({ slug: 'sales', name: 'Sales' });
    const res = await fetch(`${baseUrl}/sales/teams-identity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: '11111111-0000-4000-8000-000000000004' }),
    });
    assert.equal(res.status, 503);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      'teams_provisioner_unavailable',
    );
    assert.equal(teamsStore.rows.size, 0, 'no row created');
    assert.equal(teamsRunner.enqueueCalls.length, 0, 'nothing enqueued');
  });

  it('POST /:slug/teams-identity: client errors win over the provisioner 503 (404/400 first)', async () => {
    provisionerInstalled = false;
    // Unknown agent → 404, not 503: the operator's mistake is named even
    // while the connector is inactive.
    let res = await fetch(`${baseUrl}/ghost/teams-identity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: '11111111-0000-4000-8000-000000000004' }),
    });
    assert.equal(res.status, 404);
    // Malformed body → 400, not 503.
    await store.createAgent({ slug: 'sales', name: 'Sales' });
    res = await fetch(`${baseUrl}/sales/teams-identity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'invalid_body');
  });

  it('POST /:slug/teams-identity rejects a bot_slug longer than 63 chars (channel-teams bound)', async () => {
    await store.createAgent({ slug: 'sales', name: 'Sales' });
    const res = await fetch(`${baseUrl}/sales/teams-identity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: '11111111-0000-4000-8000-000000000004', bot_slug: 'a'.repeat(64) }),
    });
    assert.equal(res.status, 400, 'BOT_SLUG_PATTERN allows at most 63 chars');
    const ok = await fetch(`${baseUrl}/sales/teams-identity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: '11111111-0000-4000-8000-000000000004', bot_slug: 'a'.repeat(63) }),
    });
    assert.equal(ok.status, 202);
  });

  it('POST /:slug/teams-identity → 409 when the bot slug is taken by another agent', async () => {
    await store.createAgent({ slug: 'sales', name: 'Sales' });
    const err = new Error("bot slug 'sales-bot' is already used by another agent");
    (err as Error & { code?: string }).code = 'bot_slug_taken';
    teamsStore.ensureError = err;
    const res = await fetch(`${baseUrl}/sales/teams-identity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: '11111111-0000-4000-8000-000000000004', bot_slug: 'sales-bot' }),
    });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: string }).error, 'bot_slug_taken');
    assert.equal(teamsRunner.enqueueCalls.length, 0, 'nothing enqueued');
  });

  it('POST /:slug/teams-identity reports running honestly and persists a failed enqueue', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    teamsRunner.enqueueError = new Error('queue down');
    const res = await fetch(`${baseUrl}/sales/teams-identity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: '11111111-0000-4000-8000-000000000004' }),
    });
    assert.equal(res.status, 202);
    const body = (await res.json()) as { running: boolean };
    assert.equal(
      body.running,
      false,
      'a rejected enqueue must not be reported as a started run',
    );
    // The fire-and-forget catch persists the failure so GET can surface it.
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(teamsStore.enqueueFailures, [
      { agentId: agent.id, message: 'queue down' },
    ]);
    const status = await fetch(`${baseUrl}/sales/teams-identity`);
    const statusBody = (await status.json()) as {
      identity: { last_error: string | null };
    };
    assert.equal(statusBody.identity.last_error, 'enqueue_failed: queue down');
  });

  it('GET /:slug/teams-identity projects the row incl. the teams_bots[] entry with a secret ref', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    teamsStore.rows.set(agent.id, {
      agentId: agent.id,
      botSlug: 'sales-bot',
      displayName: 'Sales Bot',
      state: 'installed',
      teamId: 'aaaaaaaa-0000-4000-8000-000000000001',
      appId: 'app-123',
      tenantId: 'tenant-456',
      teamsAppId: 'teams-app-789',
      teamsAppExternalId: 'ext-000',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    teamsRunner.running.set(agent.id, 'aaaaaaaa-0000-4000-8000-000000000001');
    const res = await fetch(`${baseUrl}/sales/teams-identity`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      state: string;
      running: boolean;
      provisioner_installed: boolean;
      identity: Record<string, unknown>;
      teams_bot: Record<string, unknown>;
    };
    assert.equal(body.ok, true);
    assert.equal(body.state, 'installed');
    assert.equal(body.running, true);
    assert.equal(body.provisioner_installed, true);
    assert.equal(body.identity['teams_app_id'], 'teams-app-789');
    assert.equal(body.identity['teams_app_external_id'], 'ext-000');
    // Everything channel-teams' teams_bots[] needs — shaped exactly like a
    // parseTeamsBotsConfig entry (camelCase), with the app password as the
    // connector's opaque vault REF, never as secret material.
    assert.deepEqual(body.teams_bot, {
      botSlug: 'sales-bot',
      displayName: 'Sales Bot',
      appId: 'app-123',
      appType: 'SingleTenant',
      tenantId: 'tenant-456',
      appPasswordSecretRef: defaultTeamsBotSecretRef({ appId: 'app-123' }),
    });
    assert.equal(
      defaultTeamsBotSecretRef({ appId: 'app-123' }),
      'teams_bot_password:app-123',
      'the connector-vault ref is derived from the appId, not the bot slug',
    );
  });

  it('GET /:slug/teams-identity: teams_bot stays null before the app registration exists; 404 without a row', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    let res = await fetch(`${baseUrl}/sales/teams-identity`);
    assert.equal(res.status, 404);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      'teams_identity_not_found',
    );

    provisionerInstalled = false; // status stays readable without the connector
    teamsStore.rows.set(agent.id, {
      agentId: agent.id,
      botSlug: 'sales-bot',
      displayName: 'Sales Bot',
      state: 'pending',
      teamId: 'aaaaaaaa-0000-4000-8000-000000000001',
      appId: null,
      tenantId: null,
      teamsAppId: null,
      teamsAppExternalId: null,
      lastError: 'consent_missing: admin consent required',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    res = await fetch(`${baseUrl}/sales/teams-identity`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      provisioner_installed: boolean;
      running: boolean;
      identity: { last_error: string };
      teams_bot: unknown;
    };
    assert.equal(body.teams_bot, null);
    assert.equal(body.provisioner_installed, false);
    assert.equal(body.running, false);
    assert.equal(body.identity.last_error, 'consent_missing: admin consent required');
  });

  // ── W2a (#860): the single teams_bot projection choke point ─────────

  it('projectTeamsBotConfig is the ONE teams_bot projection — GET emits exactly its output', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    const row: OperatorTeamsIdentityRecord = {
      agentId: agent.id,
      botSlug: 'sales-bot',
      displayName: 'Sales Bot',
      state: 'installed',
      teamId: 'aaaaaaaa-0000-4000-8000-000000000001',
      appId: 'app-123',
      tenantId: 'tenant-456',
      teamsAppId: 'teams-app-789',
      teamsAppExternalId: 'ext-000',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    teamsStore.rows.set(agent.id, row);
    const res = await fetch(`${baseUrl}/sales/teams-identity`);
    const body = (await res.json()) as { teams_bot: unknown };
    // Any future team↔agent route must project through the same helper —
    // a second, drifting copy would hand operators a config channel-teams
    // silently refuses to parse.
    assert.deepEqual(body.teams_bot, projectTeamsBotConfig(row));
  });

  // ── #910: the teams_bots sync signal on the status route ────────────

  it('GET /:slug/teams-identity reports the LIVE teams_bots sync state', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    const row: OperatorTeamsIdentityRecord = {
      agentId: agent.id,
      botSlug: 'sales-bot',
      displayName: 'Sales Bot',
      state: 'installed',
      teamId: 'aaaaaaaa-0000-4000-8000-000000000001',
      appId: 'app-123',
      tenantId: 'tenant-456',
      teamsAppId: 'teams-app-789',
      teamsAppExternalId: 'ext-000',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    teamsStore.rows.set(agent.id, row);

    const read = async (): Promise<{
      state: string;
      plugin_id: string;
      config_key: string;
    }> => {
      const res = await fetch(`${baseUrl}/sales/teams-identity`);
      const body = (await res.json()) as {
        teams_bots_sync: { state: string; plugin_id: string; config_key: string };
      };
      return body.teams_bots_sync;
    };

    // No registry bound at all — the status is genuinely unknown, and the
    // route says so instead of guessing "not synced".
    assert.equal((await read()).state, 'unknown');

    const plugins = new InMemoryInstalledRegistry();
    installedPlugins = plugins;
    assert.equal((await read()).state, 'plugin_not_installed');

    await plugins.register({
      id: CHANNEL_TEAMS_PLUGIN_ID,
      installed_version: '0.21.0',
      installed_at: new Date(0).toISOString(),
      status: 'active',
      config: {},
    });
    assert.equal((await read()).state, 'missing');

    // The very block the UI offers for pasting, now actually configured.
    await plugins.updateConfig(CHANNEL_TEAMS_PLUGIN_ID, {
      [TEAMS_BOTS_CONFIG_KEY]: JSON.stringify([projectTeamsBotConfig(row)]),
    });
    const synced = await read();
    assert.equal(synced.state, 'synced');
    // The UI names both in its copy, so both are part of the contract.
    assert.equal(synced.plugin_id, CHANNEL_TEAMS_PLUGIN_ID);
    assert.equal(synced.config_key, 'teams_bots');

    // A hand edit is visible immediately — the signal is derived by LOOKING,
    // never from a stored "we synced it once" flag.
    await plugins.updateConfig(CHANNEL_TEAMS_PLUGIN_ID, {
      [TEAMS_BOTS_CONFIG_KEY]: JSON.stringify([
        { ...projectTeamsBotConfig(row), displayName: 'edited by hand' },
      ]),
    });
    assert.equal((await read()).state, 'out_of_sync');
  });

  it('GET /:slug/teams-identity: an unreadable teams_bots value is reported, not hidden', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    teamsStore.rows.set(agent.id, {
      agentId: agent.id,
      botSlug: 'sales-bot',
      displayName: 'Sales Bot',
      state: 'installed',
      teamId: 'aaaaaaaa-0000-4000-8000-000000000001',
      appId: 'app-123',
      tenantId: 'tenant-456',
      teamsAppId: 'teams-app-789',
      teamsAppExternalId: 'ext-000',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const plugins = new InMemoryInstalledRegistry();
    await plugins.register({
      id: CHANNEL_TEAMS_PLUGIN_ID,
      installed_version: '0.21.0',
      installed_at: new Date(0).toISOString(),
      status: 'active',
      config: { [TEAMS_BOTS_CONFIG_KEY]: '{ not json' },
    });
    installedPlugins = plugins;
    const res = await fetch(`${baseUrl}/sales/teams-identity`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { teams_bots_sync: { state: string } };
    assert.equal(body.teams_bots_sync.state, 'unreadable');
  });

  it('GET /:slug/teams-identity: sync is not_applicable before the app registration exists', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    teamsStore.rows.set(agent.id, {
      agentId: agent.id,
      botSlug: 'sales-bot',
      displayName: 'Sales Bot',
      state: 'pending',
      teamId: 'aaaaaaaa-0000-4000-8000-000000000001',
      appId: null,
      tenantId: null,
      teamsAppId: null,
      teamsAppExternalId: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    installedPlugins = new InMemoryInstalledRegistry();
    const res = await fetch(`${baseUrl}/sales/teams-identity`);
    const body = (await res.json()) as {
      teams_bot: unknown;
      teams_bots_sync: { state: string };
    };
    assert.equal(body.teams_bot, null);
    assert.equal(body.teams_bots_sync.state, 'not_applicable');
  });

  it('the GET projects through deps.clientSecretRef — not just through the default', async () => {
    // The pin above deep-equals `projectTeamsBotConfig(row)` (one argument)
    // against a router built WITHOUT a clientSecretRef, so both sides collapse
    // to the default ref and agree no matter what the route passes. Dropping
    // the second argument at the call site would therefore stay green while
    // the operator pastes a config pointing at a vault key that does not
    // exist and channel-teams fails bot auth at runtime. This test mounts a
    // router that DOES override the ref, so the seam is actually held.
    const overrideStore = new FakeTeamsIdentityStore();
    const overrideRunner = new FakeTeamsRunner();
    const overrideConfig = new FakeConfigStore();
    const agent = await overrideConfig.createAgent({ slug: 'sales', name: 'Sales' });
    const row: OperatorTeamsIdentityRecord = {
      agentId: agent.id,
      botSlug: 'sales-bot',
      displayName: 'Sales Bot',
      state: 'installed',
      teamId: 'aaaaaaaa-0000-4000-8000-000000000001',
      appId: 'app-123',
      tenantId: 'tenant-456',
      teamsAppId: 'teams-app-789',
      teamsAppExternalId: 'ext-000',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    overrideStore.rows.set(agent.id, row);
    const clientSecretRef = (r: OperatorTeamsIdentityRecord): string =>
      `vault://kv/teams/${r.botSlug}`;

    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/operator/agents',
      createOperatorAgentsRouter({
        getConfigStore: () => overrideConfig as unknown as ConfigStore,
        getRegistry: () => registry as unknown as OrchestratorRegistry,
        getChatSessionStore: () => sessionStore as unknown as ChatSessionStore,
        getAgentGraphStore: () => graph as unknown as AgentGraphStore,
        getTeamsIdentity: () => ({
          store: overrideStore,
          runner: overrideRunner,
          isProvisionerInstalled: () => true,
          clientSecretRef,
        }),
      }),
    );
    const overrideServer = await listenLoopback(app);
    try {
      const addr = overrideServer.address() as AddressInfo;
      const res = await fetch(
        `http://127.0.0.1:${String(addr.port)}/api/v1/operator/agents/sales/teams-identity`,
      );
      const body = (await res.json()) as {
        teams_bot: { appPasswordSecretRef: string };
      };
      assert.equal(body.teams_bot.appPasswordSecretRef, 'vault://kv/teams/sales-bot');
      assert.deepEqual(body.teams_bot, projectTeamsBotConfig(row, clientSecretRef));
    } finally {
      await new Promise<void>((r) => overrideServer.close(() => r()));
    }
  });

  // ── W2a (#860): the team_id column has exactly one honest writer ────

  it('GET /:slug/teams-identity exposes the recorded team_id so a re-run can resend it', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    teamsStore.rows.set(agent.id, {
      agentId: agent.id,
      botSlug: 'sales-bot',
      displayName: 'Sales Bot',
      state: 'app_registered',
      teamId: 'aaaaaaaa-0000-4000-8000-000000000001',
      appId: 'app-123',
      tenantId: 'tenant-456',
      teamsAppId: null,
      teamsAppExternalId: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await fetch(`${baseUrl}/sales/teams-identity`);
    const body = (await res.json()) as { identity: { team_id: string | null } };
    // POST requires `team_id` and has no fall-back-to-stored path, so without
    // this field the UI's "Re-run provisioning" button could only ever 400.
    assert.equal(body.identity.team_id, 'aaaaaaaa-0000-4000-8000-000000000001');
  });

  it('POST /:slug/teams-identity refuses to retarget an installed row instead of rewriting team_id', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    teamsStore.rows.set(agent.id, {
      agentId: agent.id,
      botSlug: 'sales-bot',
      displayName: 'Sales Bot',
      state: 'installed',
      teamId: 'aaaaaaaa-0000-4000-8000-000000000001',
      appId: 'app-123',
      tenantId: 'tenant-456',
      teamsAppId: 'teams-app-789',
      teamsAppExternalId: 'ext-000',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await fetch(`${baseUrl}/sales/teams-identity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: 'bbbbbbbb-0000-4000-8000-000000000002' }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; installed_team_id: string };
    assert.equal(body.error, 'team_install_conflict');
    assert.equal(body.installed_team_id, 'aaaaaaaa-0000-4000-8000-000000000001');
    // The runner returns early on an 'installed' row, so an accepted retarget
    // would rewrite team_id with NO install ever happening — and the team read
    // model would then publish team-b as installed on that column alone.
    assert.equal(teamsStore.rows.get(agent.id)?.teamId, 'aaaaaaaa-0000-4000-8000-000000000001');
    assert.deepEqual(teamsStore.ensureCalls, []);
    assert.deepEqual(teamsRunner.enqueueCalls, []);
  });

  it('POST /:slug/teams refuses a retarget while a run toward another team is in flight', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    teamsStore.rows.set(agent.id, {
      agentId: agent.id,
      botSlug: 'sales-bot',
      displayName: 'Sales Bot',
      state: 'catalog_uploaded',
      teamId: 'aaaaaaaa-0000-4000-8000-000000000001',
      appId: 'app-123',
      tenantId: 'tenant-456',
      teamsAppId: 'teams-app-789',
      teamsAppExternalId: 'ext-000',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    teamsRunner.running.set(agent.id, 'aaaaaaaa-0000-4000-8000-000000000001');

    const res = await fetch(`${baseUrl}/sales/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: 'bbbbbbbb-0000-4000-8000-000000000002' }),
    });

    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; pending_team_id: string };
    assert.equal(body.error, 'team_install_conflict');
    assert.equal(body.pending_team_id, 'aaaaaaaa-0000-4000-8000-000000000001');
    // The in-flight run installs into team-a (installToTeam uses the teamId
    // captured at enqueue) while the runner refuses the second enqueue with a
    // RESOLVED 'rejected' result the route cannot see. Writing team-b first
    // would leave the row claiming an install that never happened.
    assert.equal(teamsStore.rows.get(agent.id)?.teamId, 'aaaaaaaa-0000-4000-8000-000000000001');
    assert.deepEqual(teamsStore.ensureCalls, []);
    assert.deepEqual(teamsRunner.enqueueCalls, []);
  });

  it("records a RESOLVED { status: 'rejected' } enqueue result instead of dropping it", async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    teamsStore.rows.set(agent.id, {
      agentId: agent.id,
      botSlug: 'sales-bot',
      displayName: 'Sales Bot',
      state: 'app_registered',
      teamId: 'aaaaaaaa-0000-4000-8000-000000000001',
      appId: 'app-123',
      tenantId: 'tenant-456',
      teamsAppId: null,
      teamsAppExternalId: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // The real runner refuses with a resolved value, never a rejection — a
    // `.catch()`-only caller records nothing and the row keeps looking healthy.
    teamsRunner.enqueueResult = {
      status: 'rejected',
      agentId: agent.id,
      reason: 'team_conflict',
      detail: 'a provisioning run targeting team aaaaaaaa-0000-4000-8000-000000000001 is already in flight',
    };

    const res = await fetch(`${baseUrl}/sales/teams-identity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: 'aaaaaaaa-0000-4000-8000-000000000001' }),
    });
    assert.equal(res.status, 202);

    await waitFor(() => teamsStore.enqueueFailures.length > 0);
    assert.match(
      teamsStore.enqueueFailures[0]?.message ?? '',
      /already in flight/,
    );
  });

  it('projectTeamsBotConfig: null unless BOTH appId and tenantId are set', () => {
    const base: OperatorTeamsIdentityRecord = {
      agentId: 'a-1',
      botSlug: 'sales-bot',
      displayName: 'Sales Bot',
      state: 'app_registered',
      teamId: null,
      appId: null,
      tenantId: null,
      teamsAppId: null,
      teamsAppExternalId: null,
      lastError: null,
    };
    assert.equal(projectTeamsBotConfig(base), null);
    assert.equal(projectTeamsBotConfig({ ...base, appId: 'app-123' }), null);
    assert.equal(projectTeamsBotConfig({ ...base, tenantId: 'tenant-456' }), null);
    const complete = { ...base, appId: 'app-123', tenantId: 'tenant-456' };
    assert.deepEqual(projectTeamsBotConfig(complete), {
      botSlug: 'sales-bot',
      displayName: 'Sales Bot',
      appId: 'app-123',
      appType: 'SingleTenant',
      tenantId: 'tenant-456',
      appPasswordSecretRef: 'teams_bot_password:app-123',
    });
    // The password NEVER leaves the connector vault — only its opaque ref.
    assert.equal(
      JSON.stringify(projectTeamsBotConfig(complete)).includes('password:app-123'),
      true,
      'the ref is surfaced',
    );
    // An injected ref overrides the default derivation (deps.clientSecretRef).
    assert.equal(
      projectTeamsBotConfig(complete, () => 'vault://custom')?.appPasswordSecretRef,
      'vault://custom',
    );
  });

  it('GET /:slug/teams-identity decodes last_error into last_error_detail', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    const scopes = ['Application.ReadWrite.All', 'AppCatalog.ReadWrite.All'];
    const raw = consentMissingDetail(scopes);
    teamsStore.rows.set(agent.id, {
      agentId: agent.id,
      botSlug: 'sales-bot',
      displayName: 'Sales Bot',
      state: 'failed',
      teamId: 'aaaaaaaa-0000-4000-8000-000000000001',
      appId: null,
      tenantId: null,
      teamsAppId: null,
      teamsAppExternalId: null,
      lastError: raw,
    });
    const res = await fetch(`${baseUrl}/sales/teams-identity`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      identity: { last_error: string; last_error_detail: unknown };
    };
    // Additive: the raw sentence stays byte-identical for existing clients.
    assert.equal(body.identity.last_error, raw);
    assert.deepEqual(body.identity.last_error_detail, {
      code: 'consent_missing',
      scopes,
      raw,
    });
  });

  it('GET /:slug/teams-identity: last_error_detail covers arm/throttled/unknown, null when clean', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    const base: OperatorTeamsIdentityRecord = {
      agentId: agent.id,
      botSlug: 'sales-bot',
      displayName: 'Sales Bot',
      state: 'app_registered',
      teamId: 'aaaaaaaa-0000-4000-8000-000000000001',
      appId: null,
      tenantId: null,
      teamsAppId: null,
      teamsAppExternalId: null,
      lastError: null,
    };
    const cases: ReadonlyArray<{ lastError: string | null; expected: unknown }> = [
      {
        lastError: armNotConfiguredDetail(['azureSubscriptionId', 'azureResourceGroup']),
        expected: {
          code: 'arm_not_configured',
          fields: ['azureSubscriptionId', 'azureResourceGroup'],
          raw: armNotConfiguredDetail(['azureSubscriptionId', 'azureResourceGroup']),
        },
      },
      {
        lastError: throttledDetail('429 from Graph', 3, 42),
        expected: {
          code: 'throttled',
          retryAfterSeconds: 42,
          raw: throttledDetail('429 from Graph', 3, 42),
        },
      },
      {
        // A store-level write the runner does not own → unknown, raw kept.
        lastError: 'enqueue_failed: queue down',
        expected: { code: 'unknown', raw: 'enqueue_failed: queue down' },
      },
      { lastError: null, expected: null },
    ];
    for (const { lastError, expected } of cases) {
      teamsStore.rows.set(agent.id, { ...base, lastError });
      const res = await fetch(`${baseUrl}/sales/teams-identity`);
      const body = (await res.json()) as {
        identity: { last_error_detail: unknown };
      };
      assert.deepEqual(body.identity.last_error_detail, expected);
    }
  });

  it('teams-identity routes 503 when the deps are not wired', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/operator/agents',
      createOperatorAgentsRouter({
        getConfigStore: () => store as unknown as ConfigStore,
        getRegistry: () => registry as unknown as OrchestratorRegistry,
        getChatSessionStore: () => sessionStore as unknown as ChatSessionStore,
      }),
    );
    const s = await listenLoopback(app);
    try {
      await store.createAgent({ slug: 'sales', name: 'Sales' });
      const addr = s.address() as AddressInfo;
      const local = `http://127.0.0.1:${String(addr.port)}/api/v1/operator/agents`;
      const post = await fetch(`${local}/sales/teams-identity`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ team_id: '11111111-0000-4000-8000-000000000004' }),
      });
      assert.equal(post.status, 503);
      assert.equal(
        ((await post.json()) as { error: string }).error,
        'teams_identity_unavailable',
      );
      const get = await fetch(`${local}/sales/teams-identity`);
      assert.equal(get.status, 503);
      assert.equal(
        ((await get.json()) as { error: string }).error,
        'teams_identity_unavailable',
      );
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  // ── W2a (#860): team ↔ agent assignment ─────────────────────────────
  //
  // The read model is DERIVED (one nullable team_id in migration 0049, no
  // installation listing on teamsProvisioner@1), so these tests pin exactly
  // what the middleware may claim: an install only on the row's own
  // evidence, the platform's limits as data, and no route that pretends to
  // uninstall.

  function seedIdentity(
    agentId: string,
    patch: Partial<TeamsIdentityMem> = {},
  ): TeamsIdentityMem {
    const row: TeamsIdentityMem = {
      agentId,
      botSlug: 'sales-bot',
      displayName: 'Sales Bot',
      state: 'installed',
      teamId: 'aaaaaaaa-0000-4000-8000-000000000001',
      appId: 'app-123',
      tenantId: 'tenant-456',
      teamsAppId: 'teams-app-789',
      teamsAppExternalId: 'ext-000',
      lastError: null,
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
      updatedAt: new Date('2026-08-02T11:00:00.000Z'),
      ...patch,
    };
    teamsStore.rows.set(agentId, row);
    return row;
  }

  it('GET /:slug/teams derives the install from the identity row and advertises the limits', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    const row = seedIdentity(agent.id);
    const res = await fetch(`${baseUrl}/sales/teams`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      agent: string;
      state: string;
      teams: Array<Record<string, unknown>>;
      pending_team_id: string | null;
      consent: { status: string; missing_scopes: string[]; source: string };
      capabilities: typeof TEAMS_ASSIGNMENT_CAPABILITIES;
      teams_bot: unknown;
    };
    assert.equal(body.ok, true);
    assert.equal(body.agent, 'sales');
    assert.deepEqual(body.teams, [
      {
        team_id: 'aaaaaaaa-0000-4000-8000-000000000001',
        target_kind: 'team',
        // No installs store is bound in this suite, so nothing ever resolved
        // a name — the UI shows the bare id rather than inventing one.
        team_display_name: null,
        display_name_synced_at: null,
        teams_app_id: 'teams-app-789',
        installed_at: '2026-08-02T11:00:00.000Z',
        // The entry says where it comes from: the row, never a Graph listing.
        evidence: 'identity_row',
      },
    ]);
    assert.equal(body.pending_team_id, null);
    // Consent is claimed only on evidence — 'installed' is past the Graph
    // calls that need consented application permissions.
    assert.deepEqual(body.consent, {
      status: 'granted',
      missing_scopes: [],
      source: 'provisioning_state',
    });
    // The UI must not have to discover the platform's limits by failing.
    assert.equal(body.capabilities.install, true);
    // #900 — the seeded provisioner publishes uninstallFromTeam, so the
    // capability is ON and ships no reason for it.
    assert.equal(body.capabilities.uninstall, true);
    assert.equal(body.capabilities.unsupported_reason['uninstall'], undefined);
    assert.equal(body.capabilities.enumerate, false);
    assert.equal(body.capabilities.multi_team, false);
    // Same choke point as GET /:slug/teams-identity — byte-identical entry.
    assert.deepEqual(body.teams_bot, projectTeamsBotConfig(row));
  });

  it('GET /:slug/teams reports NO install while the chain is still running', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id, { state: 'catalog_uploaded', teamId: 'aaaaaaaa-0000-4000-8000-000000000001' });
    const res = await fetch(`${baseUrl}/sales/teams`);
    const body = (await res.json()) as {
      teams: unknown[];
      pending_team_id: string | null;
      consent: { status: string };
    };
    // A recorded team_id below 'installed' is the TARGET of a run, not an
    // install — claiming otherwise would invent a Teams state.
    assert.deepEqual(body.teams, []);
    assert.equal(body.pending_team_id, 'aaaaaaaa-0000-4000-8000-000000000001');
    // catalog_uploaded already required a consented Graph call.
    assert.equal(body.consent.status, 'granted');
  });

  it('GET /:slug/teams surfaces missing consent with the scopes the runner recorded', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    const scopes = ['Application.ReadWrite.All', 'AppCatalog.ReadWrite.All'];
    seedIdentity(agent.id, {
      state: 'failed',
      teamId: 'aaaaaaaa-0000-4000-8000-000000000001',
      lastError: consentMissingDetail(scopes),
    });
    const res = await fetch(`${baseUrl}/sales/teams`);
    const body = (await res.json()) as {
      teams: unknown[];
      consent: { status: string; missing_scopes: string[]; source: string };
      last_error_detail: { code: string; scopes: string[] };
    };
    assert.deepEqual(body.teams, []);
    assert.deepEqual(body.consent, {
      status: 'missing',
      missing_scopes: scopes,
      source: 'last_error',
    });
    // Structured, so the UI renders from a code + arguments, never English.
    assert.equal(body.last_error_detail.code, 'consent_missing');
    assert.deepEqual(body.last_error_detail.scopes, scopes);
  });

  it('GET /:slug/teams → 404 for an unknown agent and for an agent without an identity', async () => {
    await store.createAgent({ slug: 'sales', name: 'Sales' });
    let res = await fetch(`${baseUrl}/ghost/teams`);
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: string }).error, 'not_found');
    res = await fetch(`${baseUrl}/sales/teams`);
    assert.equal(res.status, 404);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      'teams_identity_not_found',
    );
  });

  it('POST /:slug/teams records the target and resumes the chain without awaiting it', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id, { state: 'catalog_uploaded', teamId: null });
    const res = await fetch(`${baseUrl}/sales/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: 'bbbbbbbb-0000-4000-8000-000000000002' }),
    });
    assert.equal(res.status, 202);
    const body = (await res.json()) as {
      ok: boolean;
      team_id: string;
      bot_slug: string;
      already_installed: boolean;
      running: boolean;
    };
    assert.equal(body.ok, true);
    assert.equal(body.team_id, 'bbbbbbbb-0000-4000-8000-000000000002');
    assert.equal(body.bot_slug, 'sales-bot');
    assert.equal(body.already_installed, false);
    assert.equal(body.running, true);
    // The target is written through the store's own gate (single writer),
    // reusing the row's identity — a team install never renames the bot.
    assert.deepEqual(teamsStore.ensureCalls, [
      {
        agentId: agent.id,
        botSlug: 'sales-bot',
        displayName: 'Sales Bot',
        teamId: 'bbbbbbbb-0000-4000-8000-000000000002',
        targetKind: 'team',
      },
    ]);
    assert.deepEqual(teamsStore.rows.get(agent.id)?.teamId, 'bbbbbbbb-0000-4000-8000-000000000002');
    // Installing goes through the provisioning runner — the router never
    // calls the connector itself.
    assert.deepEqual(teamsRunner.enqueueCalls, [
      {
        agentId: agent.id,
        teamId: 'bbbbbbbb-0000-4000-8000-000000000002',
        targetKind: 'team',
      },
    ]);
  });

  it('POST /:slug/teams is idempotent for the team the agent is already installed in', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id, { state: 'installed', teamId: 'aaaaaaaa-0000-4000-8000-000000000001' });
    const res = await fetch(`${baseUrl}/sales/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: 'aaaaaaaa-0000-4000-8000-000000000001' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { already_installed: boolean; running: boolean };
    assert.equal(body.already_installed, true);
    // Nothing was started, and the runner holds no run for this agent.
    assert.equal(body.running, false);
    // Nothing re-enqueued: the runner short-circuits an 'installed' row, so
    // an enqueue here would only fake progress.
    assert.deepEqual(teamsRunner.enqueueCalls, []);
    assert.deepEqual(teamsStore.ensureCalls, []);
  });

  // Without an installs store bound (migration 0051), a second team is still
  // refused: `agent_teams_identities.team_id` is the only slot there is, and
  // accepting would overwrite the record of an install that stays live in
  // Graph. The multi-team case is covered by its own suite below, which binds
  // the store.
  it('POST /:slug/teams → 409 for a SECOND team without an installs store, writing nothing', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id, { state: 'installed', teamId: 'aaaaaaaa-0000-4000-8000-000000000001' });
    const res = await fetch(`${baseUrl}/sales/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: 'bbbbbbbb-0000-4000-8000-000000000002' }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as {
      error: string;
      installed_team_id: string;
      requested_team_id: string;
      message: string;
    };
    assert.equal(body.error, 'team_install_conflict');
    assert.equal(body.installed_team_id, 'aaaaaaaa-0000-4000-8000-000000000001');
    assert.equal(body.requested_team_id, 'bbbbbbbb-0000-4000-8000-000000000002');
    assert.match(body.message, /agent_teams_installs/);
    // The tracked install must survive a refused re-target: overwriting the
    // single team_id would leave the team-a install with nothing recording it.
    assert.equal(teamsStore.rows.get(agent.id)?.teamId, 'aaaaaaaa-0000-4000-8000-000000000001');
    assert.deepEqual(teamsStore.ensureCalls, []);
    assert.deepEqual(teamsRunner.enqueueCalls, []);
  });

  // ── migration 0051: persisted bindings, several teams, resolved names ──
  //
  // The symptom this closes: before the installs table the "binding" was the
  // identity row's single `team_id`, so a second team could only be recorded
  // by destroying the first — which is why bindings looked like they did not
  // persist. These cases bind the store and pin the contract that replaces it.

  function seedInstall(
    agentId: string,
    teamId: string,
    patch: Partial<OperatorTeamsInstallRecord> = {},
  ): void {
    teamsInstalls ??= new FakeTeamsInstallStore();
    teamsInstalls.rows.push({
      agentId,
      teamId,
      teamsAppId: 'teams-app-789',
      teamDisplayName: null,
      displayNameSyncedAt: null,
      installedAt: new Date('2026-08-02T11:00:00.000Z'),
      ...patch,
    });
  }

  it('GET /:slug/teams lists EVERY persisted binding and reports multi_team', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id);
    seedInstall(agent.id, 'aaaaaaaa-0000-4000-8000-000000000001', { teamDisplayName: 'Marketing' });
    seedInstall(agent.id, 'bbbbbbbb-0000-4000-8000-000000000002', {
      installedAt: new Date('2026-08-03T09:00:00.000Z'),
    });
    const res = await fetch(`${baseUrl}/sales/teams`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      teams: Array<Record<string, unknown>>;
      capabilities: typeof TEAMS_ASSIGNMENT_CAPABILITIES;
    };
    assert.deepEqual(
      body.teams.map((team) => [team['team_id'], team['team_display_name']]),
      [
        ['aaaaaaaa-0000-4000-8000-000000000001', 'Marketing'],
        // Never resolved — the UI shows the id, it does not invent a label.
        ['bbbbbbbb-0000-4000-8000-000000000002', null],
      ],
    );
    // Both entries say they came from a recorded install, not a Graph listing.
    assert.deepEqual(
      body.teams.map((team) => team['evidence']),
      ['install_row', 'install_row'],
    );
    assert.equal(body.capabilities.multi_team, true);
    assert.equal(body.capabilities.unsupported_reason['multi_team'], undefined);
    // Still not enumerable — the connector publishes no listing method, and
    // saying otherwise would claim knowledge of installs made outside omadia.
    assert.equal(body.capabilities.enumerate, false);
  });

  it('GET /:slug/teams backfills a missing team name and PERSISTS it', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id);
    seedInstall(agent.id, 'aaaaaaaa-0000-4000-8000-000000000001');
    const lookups: string[] = [];
    resolveTeamName = (teamId) => {
      lookups.push(teamId);
      return Promise.resolve('Marketing');
    };
    const res = await fetch(`${baseUrl}/sales/teams`);
    const body = (await res.json()) as { teams: Array<Record<string, unknown>> };
    assert.equal(body.teams[0]?.['team_display_name'], 'Marketing');
    assert.deepEqual(lookups, ['aaaaaaaa-0000-4000-8000-000000000001']);
    // Written through, so the next read needs no lookup — and so the name
    // survives a connector that is later removed or downgraded.
    assert.deepEqual(teamsInstalls?.nameWrites, [
      { teamId: 'aaaaaaaa-0000-4000-8000-000000000001', displayName: 'Marketing' },
    ]);
  });

  it('GET /:slug/teams survives a failing name lookup — ids, never a 500', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id);
    seedInstall(agent.id, 'aaaaaaaa-0000-4000-8000-000000000001');
    resolveTeamName = () => Promise.reject(new Error('graph down'));
    const res = await fetch(`${baseUrl}/sales/teams`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { teams: Array<Record<string, unknown>> };
    assert.equal(body.teams[0]?.['team_id'], 'aaaaaaaa-0000-4000-8000-000000000001');
    assert.equal(body.teams[0]?.['team_display_name'], null);
  });

  it('POST /:slug/teams accepts an ADDITIONAL team once bindings persist', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id, { state: 'installed', teamId: 'aaaaaaaa-0000-4000-8000-000000000001' });
    seedInstall(agent.id, 'aaaaaaaa-0000-4000-8000-000000000001');
    const res = await fetch(`${baseUrl}/sales/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: 'bbbbbbbb-0000-4000-8000-000000000002' }),
    });
    assert.equal(res.status, 202);
    const body = (await res.json()) as { team_id: string; already_installed: boolean };
    assert.equal(body.team_id, 'bbbbbbbb-0000-4000-8000-000000000002');
    assert.equal(body.already_installed, false);
    // The chain is resumed for the NEW team; the existing binding is untouched.
    assert.deepEqual(teamsRunner.enqueueCalls, [
      {
        agentId: agent.id,
        teamId: 'bbbbbbbb-0000-4000-8000-000000000002',
        targetKind: 'team',
      },
    ]);
    assert.deepEqual(
      teamsInstalls?.rows.map((row) => row.teamId),
      ['aaaaaaaa-0000-4000-8000-000000000001'],
    );
  });

  it('POST /:slug/teams is idempotent per BINDING, not per identity row', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    // The identity's scratch `team_id` points elsewhere on purpose: the answer
    // must come from the bindings table, which is the record of what happened.
    seedIdentity(agent.id, { state: 'installed', teamId: 'bbbbbbbb-0000-4000-8000-000000000002' });
    seedInstall(agent.id, 'aaaaaaaa-0000-4000-8000-000000000001');
    const res = await fetch(`${baseUrl}/sales/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: 'aaaaaaaa-0000-4000-8000-000000000001' }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { already_installed: boolean }).already_installed, true);
    assert.deepEqual(teamsRunner.enqueueCalls, []);
  });

  it('DELETE /:slug/teams/:teamId drops ONE binding and leaves the rest installed', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id, { state: 'installed', teamId: 'aaaaaaaa-0000-4000-8000-000000000001' });
    seedInstall(agent.id, 'aaaaaaaa-0000-4000-8000-000000000001');
    seedInstall(agent.id, 'bbbbbbbb-0000-4000-8000-000000000002');
    const res = await fetch(`${baseUrl}/sales/teams/aaaaaaaa-0000-4000-8000-000000000001`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      team_id: string;
      state: string;
      remaining_team_ids: string[];
    };
    assert.equal(body.team_id, 'aaaaaaaa-0000-4000-8000-000000000001');
    assert.deepEqual(body.remaining_team_ids, ['bbbbbbbb-0000-4000-8000-000000000002']);
    // An agent still installed somewhere is still installed — walking the
    // identity back to catalog_uploaded would report team-b as pending.
    assert.equal(body.state, 'installed');
    assert.equal(teamsStore.rows.get(agent.id)?.state, 'installed');
    assert.deepEqual(
      teamsInstalls?.rows.map((row) => row.teamId),
      ['bbbbbbbb-0000-4000-8000-000000000002'],
    );
  });

  it('DELETE /:slug/teams/:teamId → 404 for a team this agent is not bound to', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id, { state: 'installed', teamId: 'aaaaaaaa-0000-4000-8000-000000000001' });
    seedInstall(agent.id, 'aaaaaaaa-0000-4000-8000-000000000001');
    const res = await fetch(`${baseUrl}/sales/teams/19%3Aghost`, { method: 'DELETE' });
    assert.equal(res.status, 404);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      'team_install_not_found',
    );
    assert.deepEqual(teamsInstalls?.removeCalls, []);
  });

  it('POST /:slug/teams: 400 without team_id, 404 unknown agent, 503 without the provisioner', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id, { state: 'catalog_uploaded', teamId: null });
    let res = await fetch(`${baseUrl}/sales/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'invalid_body');
    res = await fetch(`${baseUrl}/ghost/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: 'bbbbbbbb-0000-4000-8000-000000000002' }),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: string }).error, 'not_found');
    provisionerInstalled = false;
    try {
      res = await fetch(`${baseUrl}/sales/teams`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ team_id: 'bbbbbbbb-0000-4000-8000-000000000002' }),
      });
      assert.equal(res.status, 503);
      assert.equal(
        ((await res.json()) as { error: string }).error,
        'teams_provisioner_unavailable',
      );
    } finally {
      provisionerInstalled = true;
    }
    // No 4xx/503 path may have written or enqueued anything.
    assert.deepEqual(teamsStore.ensureCalls, []);
    assert.deepEqual(teamsRunner.enqueueCalls, []);
  });

  // ── DELETE /:slug/teams/:teamId (#900) ──────────────────────────────
  // The route removes the app through the connector's uninstallFromTeam
  // (>= 0.4.0) and only then forgets the install. A connector without the
  // method keeps the historical 501 — that is the whole feature-detection
  // contract, and both halves are pinned below.

  const deleteTeam = (slug: string, teamId: string): Promise<globalThis.Response> =>
    fetch(`${baseUrl}/${slug}/teams/${encodeURIComponent(teamId)}`, {
      method: 'DELETE',
    });

  it('DELETE /:slug/teams/:teamId removes the install and clears the row', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id, { state: 'installed', teamId: 'aaaaaaaa-0000-4000-8000-000000000001' });
    const fake = provisioner as FakeTeamsProvisioner;

    const res = await deleteTeam('sales', 'aaaaaaaa-0000-4000-8000-000000000001');
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      agent: string;
      team_id: string;
      outcome: string;
      already_absent: boolean;
      state: string;
    };
    assert.equal(body.ok, true);
    assert.equal(body.agent, 'sales');
    assert.equal(body.team_id, 'aaaaaaaa-0000-4000-8000-000000000001');
    assert.equal(body.outcome, 'uninstalled');
    assert.equal(body.already_absent, false);

    // Graph got the CATALOG app id, not the installation id — resolving the
    // latter is the connector's job.
    assert.deepEqual(fake.calls, [
      { teamId: 'aaaaaaaa-0000-4000-8000-000000000001', teamsAppId: 'teams-app-789' },
    ]);
    // The row drops back to catalog_uploaded with no team — the app, bot and
    // catalog entry all still exist, only the install is gone.
    assert.deepEqual(teamsStore.clearTeamInstalls, [agent.id]);
    assert.equal(teamsStore.rows.get(agent.id)?.teamId, null);
    assert.equal(teamsStore.rows.get(agent.id)?.state, 'catalog_uploaded');
    assert.equal(body.state, 'catalog_uploaded');
  });

  it('DELETE /:slug/teams/:teamId reports the idempotent already-absent outcome', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id, { state: 'installed', teamId: 'aaaaaaaa-0000-4000-8000-000000000001' });
    const fake = provisioner as FakeTeamsProvisioner;
    fake.outcome = 'already-absent';

    const res = await deleteTeam('sales', 'aaaaaaaa-0000-4000-8000-000000000001');
    assert.equal(res.status, 200, 'not installed is success, not a failure');
    const body = (await res.json()) as { outcome: string; already_absent: boolean };
    assert.equal(body.outcome, 'already-absent');
    assert.equal(body.already_absent, true);
    // The row is cleared either way — that is what makes the remove converge.
    assert.deepEqual(teamsStore.clearTeamInstalls, [agent.id]);
    assert.equal(teamsStore.rows.get(agent.id)?.teamId, null);
  });

  it('DELETE /:slug/teams/:teamId → 501 when the connector is too old (no uninstallFromTeam)', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id, { state: 'installed', teamId: 'aaaaaaaa-0000-4000-8000-000000000001' });
    // A connector < 0.4.0: the accessor simply has no such method.
    provisioner = new LegacyTeamsProvisioner();

    const res = await deleteTeam('sales', 'aaaaaaaa-0000-4000-8000-000000000001');
    assert.equal(res.status, 501);
    const body = (await res.json()) as {
      error: string;
      message: string;
      min_connector_version: string;
      team_id: string;
    };
    assert.equal(body.error, 'teams_uninstall_unsupported');
    assert.equal(body.team_id, 'aaaaaaaa-0000-4000-8000-000000000001');
    assert.equal(body.min_connector_version, TEAMS_UNINSTALL_MIN_CONNECTOR_VERSION);
    // The reason names the fix, not just the refusal.
    assert.match(body.message, /upgrade @omadia\/integration-microsoft365/);
    // Above all: the row is untouched. "Forgetting" the install would leave
    // the app live in Teams with nothing recording it.
    assert.equal(teamsStore.rows.get(agent.id)?.teamId, 'aaaaaaaa-0000-4000-8000-000000000001');
    assert.equal(teamsStore.rows.get(agent.id)?.state, 'installed');
    assert.deepEqual(teamsStore.clearTeamInstalls, []);
  });

  // ── DELETE for a CHAT install ───────────────────────────────────────
  // The route used to hand every recorded id to `uninstallFromTeam`, so a
  // chat install was addressed as `/teams/19:…@thread.v2/installedApps` —
  // a shape Graph rejects. Group chats are a primary use case, which made
  // this "installed and unremovable".

  const CHAT_ID = '19:aaaaaaaabbbbccccddddeeeeffff0000@thread.v2';

  it('DELETE /:slug/teams/:teamId uses uninstallFromChat for a chat install', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id, {
      state: 'installed',
      teamId: CHAT_ID,
      targetKind: 'group-chat',
    });
    const fake = new FakeTeamsChatProvisioner();
    provisioner = fake;

    const res = await deleteTeam('sales', CHAT_ID);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      team_id: string;
      target_kind: string;
      outcome: string;
    };
    assert.equal(body.ok, true);
    assert.equal(body.team_id, CHAT_ID);
    // The response names the direction that ran — a team removal and a chat
    // removal are different calls and must not read the same.
    assert.equal(body.target_kind, 'group-chat');
    assert.equal(body.outcome, 'uninstalled');

    // THE POINT: the chat endpoint, keyed `chatId`, and the team endpoint
    // never touched.
    assert.deepEqual(fake.chatCalls, [
      { chatId: CHAT_ID, teamsAppId: 'teams-app-789' },
    ]);
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(teamsStore.clearTeamInstalls, [agent.id]);
  });

  it('DELETE /:slug/teams/:teamId still uses uninstallFromTeam for a team install', async () => {
    // The other half of the branch: a connector that CAN do both must not
    // start routing team removals through the chat endpoint.
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id, {
      state: 'installed',
      teamId: 'aaaaaaaa-0000-4000-8000-000000000001',
      targetKind: 'team',
    });
    const fake = new FakeTeamsChatProvisioner();
    provisioner = fake;

    const res = await deleteTeam('sales', 'aaaaaaaa-0000-4000-8000-000000000001');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { target_kind: string };
    assert.equal(body.target_kind, 'team');
    assert.deepEqual(fake.chatCalls, []);
    assert.deepEqual(fake.calls, [
      { teamId: 'aaaaaaaa-0000-4000-8000-000000000001', teamsAppId: 'teams-app-789' },
    ]);
  });

  it('DELETE /:slug/teams/:teamId → 501 for a chat when the connector has no uninstallFromChat', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id, {
      state: 'installed',
      teamId: CHAT_ID,
      targetKind: 'group-chat',
    });
    // The seeded FakeTeamsProvisioner publishes only the TEAM method.
    const fake = provisioner as FakeTeamsProvisioner;

    const res = await deleteTeam('sales', CHAT_ID);
    assert.equal(res.status, 501);
    const body = (await res.json()) as {
      error: string;
      message: string;
      target_kind: string;
    };
    assert.equal(body.error, 'teams_chat_uninstall_unsupported');
    assert.equal(body.target_kind, 'group-chat');
    assert.match(body.message, /uninstallFromChat/);
    // Refused, never approximated: handing the chat id to the team endpoint
    // is exactly the bug, so nothing may have been called and the row stands.
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(teamsStore.clearTeamInstalls, []);
    assert.equal(teamsStore.rows.get(agent.id)?.teamId, CHAT_ID);
    assert.equal(teamsStore.rows.get(agent.id)?.state, 'installed');
  });

  it('GET /:slug/teams reports chat_uninstall separately from uninstall', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id);

    // Team-only connector: one direction true, the other false with a reason.
    const teamOnly = (await (await fetch(`${baseUrl}/sales/teams`)).json()) as {
      capabilities: Record<string, unknown> & {
        unsupported_reason: Record<string, string>;
      };
    };
    assert.equal(teamOnly.capabilities['uninstall'], true);
    assert.equal(teamOnly.capabilities['chat_uninstall'], false);
    assert.match(
      teamOnly.capabilities.unsupported_reason['chat_uninstall'] ?? '',
      /uninstallFromChat/,
    );

    provisioner = new FakeTeamsChatProvisioner();
    const both = (await (await fetch(`${baseUrl}/sales/teams`)).json()) as {
      capabilities: Record<string, unknown> & {
        unsupported_reason: Record<string, string>;
      };
    };
    assert.equal(both.capabilities['chat_uninstall'], true);
    assert.equal(both.capabilities.unsupported_reason['chat_uninstall'], undefined);
    assert.equal(agent.slug, 'sales');
  });

  it('GET /:slug/teams reports uninstall: false against a connector that is too old', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id);
    provisioner = new LegacyTeamsProvisioner();

    const res = await fetch(`${baseUrl}/sales/teams`);
    const body = (await res.json()) as {
      capabilities: typeof TEAMS_ASSIGNMENT_CAPABILITIES;
    };
    // Same verdict the DELETE would give — the UI disables the control
    // instead of discovering the 501 by pressing it.
    assert.equal(body.capabilities.uninstall, false);
    assert.match(
      body.capabilities.unsupported_reason['uninstall'] ?? '',
      /upgrade @omadia\/integration-microsoft365/,
    );
    // The structural gaps are unaffected by the connector version.
    assert.equal(body.capabilities.enumerate, false);
    assert.equal(body.capabilities.multi_team, false);
    assert.deepEqual(body.capabilities, TEAMS_ASSIGNMENT_CAPABILITIES);
  });

  it('teamsAssignmentCapabilities ships a reason for every false', () => {
    for (const canUninstall of [true, false]) {
      const caps = teamsAssignmentCapabilities(canUninstall);
      for (const key of ['install', 'uninstall', 'enumerate', 'multi_team'] as const) {
        if (caps[key]) {
          assert.equal(
            caps.unsupported_reason[key],
            undefined,
            `${key} is true — it must not carry an unsupported reason`,
          );
        } else {
          assert.ok(
            (caps.unsupported_reason[key] ?? '').length > 0,
            `${key} is false — it must ship a reason`,
          );
        }
      }
    }
  });

  it('DELETE /:slug/teams/:teamId → 404 for a team the middleware has no install for', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id, { state: 'installed', teamId: 'aaaaaaaa-0000-4000-8000-000000000001' });
    const fake = provisioner as FakeTeamsProvisioner;

    const res = await deleteTeam('sales', 'bbbbbbbb-0000-4000-8000-000000000002');
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'team_install_not_found');
    // No Graph call for an install we never recorded.
    assert.deepEqual(fake.calls, []);
    assert.equal(teamsStore.rows.get(agent.id)?.teamId, 'aaaaaaaa-0000-4000-8000-000000000001');
  });

  it('DELETE /:slug/teams/:teamId → 404 while the chain has not reached installed', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id, { state: 'catalog_uploaded', teamId: 'aaaaaaaa-0000-4000-8000-000000000001' });
    const fake = provisioner as FakeTeamsProvisioner;

    const res = await deleteTeam('sales', 'aaaaaaaa-0000-4000-8000-000000000001');
    assert.equal(res.status, 404);
    // A recorded team below 'installed' is a TARGET, not an install — the
    // read model does not list it, so the route must not remove it either.
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(teamsStore.clearTeamInstalls, []);
  });

  it('DELETE /:slug/teams/:teamId → 409 while a provisioning run is in flight', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id, { state: 'installed', teamId: 'aaaaaaaa-0000-4000-8000-000000000001' });
    teamsRunner.running.set(agent.id, 'aaaaaaaa-0000-4000-8000-000000000001');
    const fake = provisioner as FakeTeamsProvisioner;

    const res = await deleteTeam('sales', 'aaaaaaaa-0000-4000-8000-000000000001');
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'teams_provisioning_running');
    // Racing the runner would let it re-install right behind the removal.
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(teamsStore.clearTeamInstalls, []);
    teamsRunner.running.delete(agent.id);
  });

  it('DELETE /:slug/teams/:teamId → 503 when the connector is not installed at all', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id, { state: 'installed', teamId: 'aaaaaaaa-0000-4000-8000-000000000001' });
    provisionerInstalled = false;
    provisioner = undefined;
    try {
      const res = await deleteTeam('sales', 'aaaaaaaa-0000-4000-8000-000000000001');
      assert.equal(res.status, 503);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, 'teams_provisioner_unavailable');
    } finally {
      provisionerInstalled = true;
    }
    assert.equal(teamsStore.rows.get(agent.id)?.teamId, 'aaaaaaaa-0000-4000-8000-000000000001');
    assert.deepEqual(teamsStore.clearTeamInstalls, []);
  });

  it('DELETE /:slug/teams/:teamId keeps the row when the connector call fails', async () => {
    const agent = await store.createAgent({ slug: 'sales', name: 'Sales' });
    seedIdentity(agent.id, { state: 'installed', teamId: 'aaaaaaaa-0000-4000-8000-000000000001' });
    const fake = provisioner as FakeTeamsProvisioner;
    const consent = new Error('403 from graph');
    consent.name = 'ConsentMissingError';
    fake.error = consent;

    const res = await deleteTeam('sales', 'aaaaaaaa-0000-4000-8000-000000000001');
    assert.notEqual(res.status, 200);
    // Graph first, row second: a failed removal must not make the middleware
    // forget an install that is still live in Teams.
    assert.deepEqual(teamsStore.clearTeamInstalls, []);
    assert.equal(teamsStore.rows.get(agent.id)?.teamId, 'aaaaaaaa-0000-4000-8000-000000000001');
    assert.equal(teamsStore.rows.get(agent.id)?.state, 'installed');
  });

  it('projectInstalledTeams / projectTeamsConsent are pure and evidence-bound', () => {
    const base: OperatorTeamsIdentityRecord = {
      agentId: 'a-1',
      botSlug: 'sales-bot',
      displayName: 'Sales Bot',
      state: 'installed',
      teamId: 'aaaaaaaa-0000-4000-8000-000000000001',
      appId: 'app-123',
      tenantId: 'tenant-456',
      teamsAppId: 'teams-app-789',
      teamsAppExternalId: 'ext-000',
      lastError: null,
    };
    // At most ONE team — the schema records exactly one install target.
    assert.equal(projectInstalledTeams(base).length, 1);
    assert.equal(projectInstalledTeams(base)[0]?.installed_at, null);
    // No team, or a state short of 'installed' → nothing to report.
    assert.deepEqual(projectInstalledTeams({ ...base, teamId: null }), []);
    assert.deepEqual(projectInstalledTeams({ ...base, state: 'bot_created' }), []);
    // Consent: unknown before the first consented Graph call succeeded.
    assert.equal(projectTeamsConsent({ ...base, state: 'app_registered' }).status, 'unknown');
    // An ARM failure is not a consent verdict.
    assert.equal(
      projectTeamsConsent({
        ...base,
        state: 'app_registered',
        lastError: armNotConfiguredDetail(['ARM_SUBSCRIPTION_ID']),
      }).status,
      'unknown',
    );
    // A recorded consent failure wins over the state.
    assert.deepEqual(
      projectTeamsConsent({ ...base, lastError: consentMissingDetail(['Group.Read.All']) }),
      { status: 'missing', missing_scopes: ['Group.Read.All'], source: 'last_error' },
    );
  });

  it('the team routes 503 when the teams deps are not wired', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/operator/agents',
      createOperatorAgentsRouter({
        getConfigStore: () => store as unknown as ConfigStore,
        getRegistry: () => registry as unknown as OrchestratorRegistry,
        getChatSessionStore: () => sessionStore as unknown as ChatSessionStore,
      }),
    );
    const s = await listenLoopback(app);
    try {
      await store.createAgent({ slug: 'sales', name: 'Sales' });
      const addr = s.address() as AddressInfo;
      const local = `http://127.0.0.1:${String(addr.port)}/api/v1/operator/agents`;
      for (const res of [
        await fetch(`${local}/sales/teams`),
        await fetch(`${local}/sales/teams`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ team_id: '11111111-0000-4000-8000-000000000004' }),
        }),
        await fetch(`${local}/sales/teams/19:t`, { method: 'DELETE' }),
      ]) {
        assert.equal(res.status, 503);
        assert.equal(
          ((await res.json()) as { error: string }).error,
          'teams_identity_unavailable',
        );
      }
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it('PUT /:slug/bindings replaces the channel bindings', async () => {
    const agent = await store.createAgent({ slug: 'public', name: 'Public' });
    const res = await fetch(`${baseUrl}/public/bindings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bindings: [
          { channel_type: 'teams', channel_key: '28:abc' },
          { channel_type: 'telegram', channel_key: '@bot' },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const bindings = await store.listChannelBindingsForAgent(agent.id);
    assert.equal(bindings.length, 2);
  });

  it('PUT /fallback sets and clears the fallback agent', async () => {
    await store.createAgent({ slug: 'pub', name: 'Pub' });
    let res = await fetch(`${baseUrl}/fallback`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'pub' }),
    });
    assert.equal(res.status, 200);
    assert.ok(store.fallbackId);

    res = await fetch(`${baseUrl}/fallback`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: null }),
    });
    assert.equal(res.status, 200);
    assert.equal(store.fallbackId, null);
  });

  it('POST /:slug/drain calls forceInvalidate(drain)', async () => {
    await store.createAgent({ slug: 'public', name: 'Public' });
    const res = await fetch(`${baseUrl}/public/drain`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { affected: number };
    assert.equal(body.affected, 2);
    assert.deepEqual(registry.invalidateCalls, [
      { slug: 'public', mode: 'drain' },
    ]);
  });

  it('POST /:slug/kill calls forceInvalidate(kill)', async () => {
    await store.createAgent({ slug: 'public', name: 'Public' });
    const res = await fetch(`${baseUrl}/public/kill`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(registry.invalidateCalls, [
      { slug: 'public', mode: 'kill' },
    ]);
  });

  it('POST /reload triggers a manual registry reload', async () => {
    const res = await fetch(`${baseUrl}/reload`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(registry.reloadCalls, 1);
  });

  it('503 when the orchestratorRegistry is not published', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/operator/agents',
      createOperatorAgentsRouter({
        getConfigStore: () => undefined,
        getRegistry: () => undefined,
        getChatSessionStore: () => undefined,
      }),
    );
    const s = await listenLoopback(app);
    try {
      const addr = s.address() as AddressInfo;
      const res = await fetch(
        `http://127.0.0.1:${String(addr.port)}/api/v1/operator/agents`,
      );
      assert.equal(res.status, 503);
      // Without a cause resolver the payload is exactly what it always was.
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['error'], 'multi_orchestrator_unavailable');
      assert.equal('cause' in body, false);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  // OM-75 / OM-78 (#1000, #1001) — the readiness banner reads `cause` off this
  // 503 to tell "no access at all" from "access exists, orchestrator not
  // assigned to it". A failing resolver must degrade, never hang or 500.
  it('503 carries the readiness cause when a resolver is wired', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/operator/agents',
      createOperatorAgentsRouter({
        getConfigStore: () => undefined,
        getRegistry: () => undefined,
        getChatSessionStore: () => undefined,
        getReadinessCause: async () => 'no_assignment',
      }),
    );
    const s = await listenLoopback(app);
    try {
      const addr = s.address() as AddressInfo;
      const res = await fetch(
        `http://127.0.0.1:${String(addr.port)}/api/v1/operator/agents`,
      );
      assert.equal(res.status, 503);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['error'], 'multi_orchestrator_unavailable');
      assert.equal(body['cause'], 'no_assignment');
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it('503 degrades the cause to unknown when the resolver rejects', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/operator/agents',
      createOperatorAgentsRouter({
        getConfigStore: () => undefined,
        getRegistry: () => undefined,
        getChatSessionStore: () => undefined,
        getReadinessCause: async () => {
          throw new Error('vault exploded');
        },
      }),
    );
    const s = await listenLoopback(app);
    try {
      const addr = s.address() as AddressInfo;
      const res = await fetch(
        `http://127.0.0.1:${String(addr.port)}/api/v1/operator/agents`,
      );
      assert.equal(res.status, 503);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['cause'], 'unknown');
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});
