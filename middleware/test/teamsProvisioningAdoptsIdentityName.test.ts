/**
 * #967 — the provisioned Teams name becomes the agent's own name.
 *
 * THE FIELD-TEST BUG. A bot provisioned as `Messias` in the tenant introduced
 * itself in chat as the platform assistant, because the operator's display
 * name landed on the bot registration and in the app package and NOWHERE
 * else: `agent_identities` stayed empty, so the agent fell through to the
 * platform-wide identity — one bot wearing two names.
 *
 * THE HARD CONDITION. An identity somebody actually authored must never be
 * overwritten by a provisioning run. Losing a curated persona, description and
 * tone is strictly worse than the mismatch this repairs, so the "already
 * named" case is the most important thing this file pins.
 *
 * The refusal itself lives in the store's SQL (`adoptDisplayName`), where it
 * is atomic; `agentIdentityStore.pg.test.ts` proves it against the real
 * constraint. What is proven HERE is the routing decision: that provisioning
 * reaches for the adoption at all, that it passes the name the bot actually
 * wears (not the one the request asked for), that a refused adoption does not
 * roll live sessions, and that neither a missing identity store nor a failing
 * one can take provisioning down with it.
 */

import { strict as assert } from 'node:assert';
import { after, afterEach, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import type { ConfigStore, OrchestratorRegistry } from '@omadia/orchestrator';

import {
  createOperatorAgentsRouter,
  type OperatorAgentIdentityStore,
  type OperatorTeamsIdentityRecord,
} from '../src/routes/operatorAgents.js';
import type {
  AgentIdentityAvatarInput,
  AgentIdentityComposedPrompt,
  AgentIdentityRecord,
  AgentIdentitySaveInput,
} from '../src/platform/agentIdentityStore.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const AGENT_ID = 'agent-messias';
const TEAM_ID = 'abcabcab-0000-4000-8000-000000000003';

class FakeConfigStore {
  getAgentBySlug(slug: string): Promise<
    { id: string; slug: string; name: string; description: string | null } | undefined
  > {
    return Promise.resolve(
      slug === 'messias'
        ? { id: AGENT_ID, slug: 'messias', name: 'messias', description: null }
        : undefined,
    );
  }
}

/**
 * In-memory `agent_identities` with the REAL adoption semantics — the guard
 * mirrors the store's `ON CONFLICT … DO UPDATE … WHERE display_name IS NULL
 * OR btrim(display_name) = ''`. A fake that adopted unconditionally would make
 * the case that matters most pass for the wrong reason.
 */
class FakeIdentityStore implements OperatorAgentIdentityStore {
  public rows = new Map<string, AgentIdentityRecord>();
  public adoptCalls: Array<{ agentId: string; displayName: string }> = [];
  /** When set, every call rejects — the "identity table is unreachable" case. */
  public failure: Error | undefined;

  getByAgentId(agentId: string): Promise<AgentIdentityRecord | undefined> {
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve(this.rows.get(agentId));
  }

  adoptDisplayName(
    agentId: string,
    displayName: string,
  ): Promise<AgentIdentityRecord | undefined> {
    this.adoptCalls.push({ agentId, displayName });
    if (this.failure) return Promise.reject(this.failure);
    const name = displayName.trim();
    if (name.length === 0) return Promise.resolve(this.rows.get(agentId));
    const existing = this.rows.get(agentId);
    // The guard, verbatim: a row that already carries a name is refused, and
    // the caller gets the stored row back unchanged.
    if (existing && (existing.displayName ?? '').trim().length > 0) {
      return Promise.resolve(existing);
    }
    const next: AgentIdentityRecord = {
      ...(existing ?? blankIdentity(agentId)),
      displayName: name,
      updatedAt: new Date('2026-08-31T12:00:00.000Z'),
    };
    this.rows.set(agentId, next);
    return Promise.resolve(next);
  }

  save(
    agentId: string,
    input: AgentIdentitySaveInput,
  ): Promise<AgentIdentityRecord> {
    const next: AgentIdentityRecord = {
      ...blankIdentity(agentId),
      ...input,
      revision: (this.rows.get(agentId)?.revision ?? 0) + 1,
    };
    this.rows.set(agentId, next);
    return Promise.resolve(next);
  }

  recompose(
    agentId: string,
    composed: AgentIdentityComposedPrompt,
  ): Promise<AgentIdentityRecord | undefined> {
    const existing = this.rows.get(agentId);
    if (!existing) return Promise.resolve(undefined);
    const next = { ...existing, composed };
    this.rows.set(agentId, next);
    return Promise.resolve(next);
  }

  setAvatar(
    agentId: string,
    avatar: AgentIdentityAvatarInput,
  ): Promise<AgentIdentityRecord> {
    const next: AgentIdentityRecord = {
      ...(this.rows.get(agentId) ?? blankIdentity(agentId)),
      avatar: { etag: avatar.etag },
    };
    this.rows.set(agentId, next);
    return Promise.resolve(next);
  }

  clearAvatar(agentId: string): Promise<AgentIdentityRecord | undefined> {
    return Promise.resolve(this.rows.get(agentId));
  }

  getAvatar(): Promise<{ bytes: Uint8Array; etag: string } | undefined> {
    return Promise.resolve(undefined);
  }
}

function blankIdentity(agentId: string): AgentIdentityRecord {
  return {
    agentId,
    displayName: null,
    shortDescription: null,
    longDescription: null,
    instructions: null,
    accentColor: null,
    persona: null,
    quality: null,
    composed: { text: null, family: null },
    revision: 1,
    avatar: null,
    createdAt: new Date('2026-08-31T10:00:00.000Z'),
    updatedAt: new Date('2026-08-31T10:00:00.000Z'),
  };
}

/** A fully authored identity — the one a provisioning run must not touch. */
function curatedIdentity(): AgentIdentityRecord {
  return {
    ...blankIdentity(AGENT_ID),
    displayName: 'Karen',
    shortDescription: 'Kümmert sich um HR-Anliegen',
    longDescription: 'Karen beantwortet Fragen rund um Urlaub und Verträge.',
    instructions: 'Antworte knapp und freundlich.',
    accentColor: '#123456',
    revision: 7,
  };
}

class FakeTeamsIdentityStore {
  public rows = new Map<string, OperatorTeamsIdentityRecord>();

  getByAgentId(agentId: string): Promise<OperatorTeamsIdentityRecord | undefined> {
    return Promise.resolve(this.rows.get(agentId));
  }

  /** Mirrors the real store: create-if-absent, and an existing row keeps its
   *  `display_name` no matter what the request asked for. */
  ensureForAgent(input: {
    agentId: string;
    botSlug: string;
    displayName: string;
    teamId?: string;
  }): Promise<OperatorTeamsIdentityRecord> {
    const existing = this.rows.get(input.agentId);
    if (existing) {
      const next = { ...existing, teamId: input.teamId ?? existing.teamId };
      this.rows.set(input.agentId, next);
      return Promise.resolve(next);
    }
    const row: OperatorTeamsIdentityRecord = {
      agentId: input.agentId,
      botSlug: input.botSlug,
      displayName: input.displayName,
      state: 'pending',
      teamId: input.teamId ?? null,
      appId: null,
      tenantId: null,
      teamsAppId: null,
      teamsAppExternalId: null,
      lastError: null,
      createdAt: new Date('2026-08-31T09:00:00.000Z'),
      updatedAt: new Date('2026-08-31T09:00:00.000Z'),
    };
    this.rows.set(input.agentId, row);
    return Promise.resolve(row);
  }

  recordEnqueueFailure(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeTeamsRunner {
  public enqueued: Array<{ agentId: string; teamId: string }> = [];

  enqueue(request: { agentId: string; teamId: string }): Promise<unknown> {
    this.enqueued.push({ agentId: request.agentId, teamId: request.teamId });
    // Never settles: reaching an assertion proves the route did not await it.
    return new Promise<unknown>(() => {});
  }

  isRunning(): boolean {
    return false;
  }

  runningTeamId(): string | null {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('teams provisioning adopts the display name into the agent identity (#967)', () => {
  let server: Server;
  let baseUrl: string;
  let identityStore = new FakeIdentityStore();
  let teamsStore = new FakeTeamsIdentityStore();
  let teamsRunner = new FakeTeamsRunner();
  let identityWired = true;
  let reloads = 0;

  const registry = {
    reload: () => {
      reloads += 1;
      return Promise.resolve({ actions: [], platformChanged: false });
    },
  } as unknown as OrchestratorRegistry;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/operator/agents',
      createOperatorAgentsRouter({
        getConfigStore: () => new FakeConfigStore() as unknown as ConfigStore,
        getRegistry: () => registry,
        getChatSessionStore: () => undefined,
        getAgentIdentity: () =>
          identityWired ? { store: identityStore } : undefined,
        getTeamsIdentity: () => ({
          store: teamsStore as never,
          runner: teamsRunner,
          isProvisionerInstalled: () => true,
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
    identityStore = new FakeIdentityStore();
    teamsStore = new FakeTeamsIdentityStore();
    teamsRunner = new FakeTeamsRunner();
    identityWired = true;
    reloads = 0;
  });

  function provision(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}/messias/teams-identity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: TEAM_ID, ...body }),
    });
  }

  it('gives an agent WITHOUT an identity the name it was provisioned under', async () => {
    const res = await provision({ display_name: 'Messias' });

    assert.equal(res.status, 202);
    const identity = identityStore.rows.get(AGENT_ID);
    assert.equal(
      identity?.displayName,
      'Messias',
      'the name on the Teams bot must be the name the agent answers to',
    );
    // And the running Agent has to hear about it — the name is part of its
    // system prompt, so a stored name nobody rebuilt for is a name the bot
    // never says.
    assert.equal(reloads, 1);
  });

  it('leaves an AUTHORED identity completely untouched', async () => {
    // The case that matters most: someone built this persona by hand.
    identityStore.rows.set(AGENT_ID, curatedIdentity());

    const res = await provision({ display_name: 'Messias' });

    assert.equal(res.status, 202);
    assert.deepEqual(
      identityStore.rows.get(AGENT_ID),
      curatedIdentity(),
      'a provisioning run must never overwrite an authored identity',
    );
    // Nothing changed, so nothing may roll live sessions either.
    assert.equal(reloads, 0);
  });

  it('re-running provisioning changes nothing the second time', async () => {
    await provision({ display_name: 'Messias' });
    const afterFirst = identityStore.rows.get(AGENT_ID);
    assert.equal(reloads, 1);

    await provision({ display_name: 'Messias' });

    assert.deepEqual(identityStore.rows.get(AGENT_ID), afterFirst);
    assert.equal(reloads, 1, 'an idempotent re-run must not roll sessions');
  });

  it('a later re-POST under a NEW name does not rename the agent', async () => {
    await provision({ display_name: 'Messias' });

    // `ensureForAgent` is create-if-absent: the Teams row keeps the name it
    // was created with, so the tenant still shows `Messias`. Adopting the
    // request's name here would re-create the very split this fixes, pointing
    // the other way — inwardly `Judas`, outwardly `Messias`.
    await provision({ display_name: 'Judas' });

    assert.equal(identityStore.rows.get(AGENT_ID)?.displayName, 'Messias');
    assert.deepEqual(
      identityStore.adoptCalls.map((c) => c.displayName),
      ['Messias', 'Messias'],
      'the adoption follows the stored bot name, never the request body',
    );
  });

  it('adopts the agent name when the request names no bot at all', async () => {
    // No `display_name` in the body: the route falls back to the registry
    // name, which is then what the tenant sees — and what the bot should say.
    await provision({});

    assert.equal(identityStore.rows.get(AGENT_ID)?.displayName, 'messias');
  });

  it('a blank display_name in an existing row is treated as unset', async () => {
    // `resolveAgentIdentity` already reads blank as "inherit", so filling it
    // takes nothing away from the operator.
    identityStore.rows.set(AGENT_ID, {
      ...blankIdentity(AGENT_ID),
      displayName: '   ',
      instructions: 'Antworte knapp.',
    });

    await provision({ display_name: 'Messias' });

    const identity = identityStore.rows.get(AGENT_ID);
    assert.equal(identity?.displayName, 'Messias');
    assert.equal(
      identity?.instructions,
      'Antworte knapp.',
      'adopting a name must not disturb anything else on the row',
    );
  });

  it('provisioning still succeeds when the identity store is not wired', async () => {
    identityWired = false;

    const res = await provision({ display_name: 'Messias' });

    assert.equal(res.status, 202);
    assert.equal(teamsRunner.enqueued.length, 1);
  });

  it('a failing adoption does not take provisioning down with it', async () => {
    // Provisioning is the operator's actual intent; the name adoption is
    // convergence on top of it. A dead identity table must not cost them the
    // bot.
    identityStore.failure = new Error('relation "agent_identities" is gone');

    const res = await provision({ display_name: 'Messias' });

    assert.equal(res.status, 202);
    assert.equal(teamsRunner.enqueued.length, 1);
  });

  it('adopts the name BEFORE the provisioning run is enqueued', async () => {
    // Ordering is load-bearing: the run builds the Teams app package from the
    // identity, so an adoption that landed afterwards would ship the first
    // package from a row that did not have the name yet.
    let identityAtEnqueue: string | null | undefined;
    const runner = teamsRunner;
    const originalEnqueue = runner.enqueue.bind(runner);
    runner.enqueue = (request: { agentId: string; teamId: string }) => {
      identityAtEnqueue = identityStore.rows.get(AGENT_ID)?.displayName;
      return originalEnqueue(request);
    };

    await provision({ display_name: 'Messias' });

    assert.equal(identityAtEnqueue, 'Messias');
  });
});
