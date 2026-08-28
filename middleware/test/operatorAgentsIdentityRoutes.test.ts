/**
 * #914 — agent identity REST surface (`/:slug/identity*`).
 *
 * Its own file rather than another 200 lines in `operatorAgentsRouter.test.ts`:
 * this is a self-contained surface with its own fake (an identity store), and
 * the harness it needs is a fraction of that suite's.
 *
 * What is proven here:
 *  1. GET projects BOTH views — authored (nullable) and resolved (fallbacks
 *     applied) — for an agent that has no identity row at all.
 *  2. PUT replaces the authored fields, blanks clear back to inherited, and
 *     the revision only moves when the content actually changed.
 *  3. An avatar upload derives and stores icons; a non-image body is a 400
 *     and a wrong content type a 415 — neither reaches the store.
 *  4. A write on an INSTALLED Teams identity enqueues a REPUBLISH run; the
 *     same write on an agent without one says so instead of pretending.
 *  5. Every endpoint 503s with `agent_identity_unavailable` when the store is
 *     not wired.
 */

import { strict as assert } from 'node:assert';
import { after, afterEach, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import sharp from 'sharp';

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

interface FakeAgent {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly modelRouting?: Record<string, unknown> | null;
}

class FakeConfigStore {
  private readonly agents: FakeAgent[] = [
    {
      id: 'agent-1',
      slug: 'sales',
      name: 'Sales Agent',
      description: 'Sells',
      // Persona axes are deltas against the model family's own baseline, so
      // the agent's routing decides which traits get written at all.
      modelRouting: { main: 'anthropic:claude-opus-5' },
    },
    { id: 'agent-2', slug: 'plain', name: 'Plain Agent', description: null },
  ];

  getAgentBySlug(slug: string): Promise<FakeAgent | undefined> {
    return Promise.resolve(this.agents.find((a) => a.slug === slug));
  }
}

/**
 * In-memory identity store with the REAL revision semantics: a save that
 * changes nothing must not bump it, because the route's republish decision is
 * built on exactly that.
 */
class FakeIdentityStore implements OperatorAgentIdentityStore {
  public rows = new Map<string, AgentIdentityRecord>();
  public avatars = new Map<string, AgentIdentityAvatarInput>();

  getByAgentId(agentId: string): Promise<AgentIdentityRecord | undefined> {
    return Promise.resolve(this.rows.get(agentId));
  }

  save(
    agentId: string,
    input: AgentIdentitySaveInput,
  ): Promise<AgentIdentityRecord> {
    const existing = this.rows.get(agentId);
    const norm = (v: string | null): string | null => {
      const t = (v ?? '').trim();
      return t.length > 0 ? t : null;
    };
    const next: AgentIdentityRecord = {
      agentId,
      displayName: norm(input.displayName),
      shortDescription: norm(input.shortDescription),
      longDescription: norm(input.longDescription),
      instructions: norm(input.instructions),
      accentColor: norm(input.accentColor),
      persona: input.persona,
      quality: input.quality,
      composed: input.composed,
      revision: existing?.revision ?? 1,
      avatar: existing?.avatar ?? null,
      createdAt: existing?.createdAt ?? new Date('2026-08-28T10:00:00.000Z'),
      updatedAt: new Date('2026-08-28T10:00:00.000Z'),
    };
    const unchanged =
      existing !== undefined &&
      existing.displayName === next.displayName &&
      existing.shortDescription === next.shortDescription &&
      existing.longDescription === next.longDescription &&
      existing.instructions === next.instructions &&
      existing.accentColor === next.accentColor &&
      JSON.stringify(existing.persona ?? null) ===
        JSON.stringify(next.persona ?? null) &&
      JSON.stringify(existing.quality ?? null) ===
        JSON.stringify(next.quality ?? null);
    if (unchanged) return Promise.resolve(existing);
    const bumped = { ...next, revision: (existing?.revision ?? 0) + 1 };
    this.rows.set(agentId, bumped);
    return Promise.resolve(bumped);
  }

  setAvatar(
    agentId: string,
    avatar: AgentIdentityAvatarInput,
  ): Promise<AgentIdentityRecord> {
    this.avatars.set(agentId, avatar);
    const existing = this.rows.get(agentId);
    const next: AgentIdentityRecord = {
      agentId,
      displayName: existing?.displayName ?? null,
      shortDescription: existing?.shortDescription ?? null,
      longDescription: existing?.longDescription ?? null,
      instructions: existing?.instructions ?? null,
      accentColor: existing?.accentColor ?? null,
      persona: existing?.persona ?? null,
      quality: existing?.quality ?? null,
      composed: existing?.composed ?? { text: null, family: null },
      revision: (existing?.revision ?? 0) + 1,
      avatar: { etag: avatar.etag },
      createdAt: existing?.createdAt ?? new Date('2026-08-28T10:00:00.000Z'),
      updatedAt: new Date('2026-08-28T10:05:00.000Z'),
    };
    this.rows.set(agentId, next);
    return Promise.resolve(next);
  }

  clearAvatar(agentId: string): Promise<AgentIdentityRecord | undefined> {
    const existing = this.rows.get(agentId);
    if (!existing || existing.avatar === null) return Promise.resolve(existing);
    this.avatars.delete(agentId);
    const next = {
      ...existing,
      avatar: null,
      revision: existing.revision + 1,
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
    // Mirrors the real store: the prompt is refreshed, the revision is NOT —
    // nothing the operator authored changed.
    const next = { ...existing, composed };
    this.rows.set(agentId, next);
    return Promise.resolve(next);
  }

  getAvatar(
    agentId: string,
  ): Promise<{ bytes: Uint8Array; etag: string } | undefined> {
    const avatar = this.avatars.get(agentId);
    return Promise.resolve(
      avatar ? { bytes: avatar.original, etag: avatar.etag } : undefined,
    );
  }
}

interface EnqueuedRun {
  readonly agentId: string;
  readonly teamId: string;
  readonly republish?: boolean;
}

class FakeTeamsIdentityStore {
  public row: OperatorTeamsIdentityRecord | undefined;

  getByAgentId(): Promise<OperatorTeamsIdentityRecord | undefined> {
    return Promise.resolve(this.row);
  }

  ensureForAgent(): Promise<OperatorTeamsIdentityRecord> {
    throw new Error('not used by the identity routes');
  }
}

class FakeTeamsRunner {
  public runs: EnqueuedRun[] = [];

  enqueue(request: EnqueuedRun): Promise<unknown> {
    this.runs.push(request);
    return Promise.resolve({ status: 'installed', agentId: request.agentId });
  }

  isRunning(): boolean {
    return false;
  }

  runningTeamId(): string | null {
    return null;
  }
}

function installedTeamsRow(): OperatorTeamsIdentityRecord {
  return {
    agentId: 'agent-1',
    botSlug: 'sales',
    displayName: 'Sales Agent',
    state: 'installed',
    teamId: '19:team-abc',
    appId: 'app-1',
    tenantId: 'tenant-1',
    teamsAppId: 'catalog-1',
    teamsAppExternalId: 'external-1',
    lastError: null,
    createdAt: new Date('2026-08-28T09:00:00.000Z'),
    updatedAt: new Date('2026-08-28T09:00:00.000Z'),
  };
}

/** A tiny opaque PNG — the shape a photo upload has. */
async function opaquePng(size = 200): Promise<Buffer> {
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      background: { r: 10, g: 120, b: 200 },
    },
  })
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('operator agent identity routes (#914)', () => {
  let server: Server;
  let baseUrl: string;
  let store = new FakeConfigStore();
  let identityStore = new FakeIdentityStore();
  let teamsStore = new FakeTeamsIdentityStore();
  let teamsRunner = new FakeTeamsRunner();
  let identityWired = true;
  let provisionerInstalled = true;

  let reloads = 0;
  const registry = {
    reload: () => {
      reloads += 1;
      return Promise.resolve();
    },
  } as unknown as OrchestratorRegistry;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/operator/agents',
      createOperatorAgentsRouter({
        getConfigStore: () => store as unknown as ConfigStore,
        getRegistry: () => registry,
        getChatSessionStore: () => undefined,
        getAgentIdentity: () =>
          identityWired ? { store: identityStore } : undefined,
        getTeamsIdentity: () => ({
          store: teamsStore as never,
          runner: teamsRunner,
          isProvisionerInstalled: () => provisionerInstalled,
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
    identityStore = new FakeIdentityStore();
    teamsStore = new FakeTeamsIdentityStore();
    teamsRunner = new FakeTeamsRunner();
    identityWired = true;
    provisionerInstalled = true;
    reloads = 0;
  });

  interface IdentityBody {
    identity: {
      display_name: string | null;
      short_description: string | null;
      revision: number;
      avatar: { etag: string; url: string } | null;
    };
    resolved: {
      display_name: string;
      short_description: string | null;
      has_avatar: boolean;
    };
    composed_prompt: string | null;
    composed_family: string | null;
    republish?: string;
    outline_derived?: boolean;
    dropped_boundary_presets?: string[];
  }

  it('GET reports the agent as unauthored and resolves the registry values', async () => {
    const res = await fetch(`${baseUrl}/sales/identity`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as IdentityBody;
    // Nothing authored…
    assert.equal(body.identity.display_name, null);
    assert.equal(body.identity.avatar, null);
    assert.equal(body.identity.revision, 1);
    // …but the agent still HAS a name and a description.
    assert.equal(body.resolved.display_name, 'Sales Agent');
    assert.equal(body.resolved.short_description, 'Sells');
    assert.equal(body.resolved.has_avatar, false);
  });

  it('PUT stores the authored fields and reports the resolved ones', async () => {
    const res = await fetch(`${baseUrl}/sales/identity`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        display_name: 'Vertrieb',
        short_description: 'Answers sales questions',
        accent_color: '#123456',
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as IdentityBody;
    assert.equal(body.identity.display_name, 'Vertrieb');
    assert.equal(body.resolved.display_name, 'Vertrieb');
    assert.equal(body.identity.revision, 1);
    assert.equal(identityStore.rows.get('agent-1')?.displayName, 'Vertrieb');
  });

  it('a blank field clears back to inherited rather than storing an empty string', async () => {
    await fetch(`${baseUrl}/sales/identity`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Vertrieb' }),
    });
    const res = await fetch(`${baseUrl}/sales/identity`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: '   ' }),
    });
    const body = (await res.json()) as IdentityBody;
    assert.equal(body.identity.display_name, null);
    assert.equal(body.resolved.display_name, 'Sales Agent');
  });

  it('rejects a short description longer than the Teams manifest allows', async () => {
    const res = await fetch(`${baseUrl}/sales/identity`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ short_description: 'x'.repeat(81) }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'invalid_body');
  });

  it('rejects an accent colour that is not #RRGGBB', async () => {
    const res = await fetch(`${baseUrl}/sales/identity`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accent_color: 'purple' }),
    });
    assert.equal(res.status, 400);
  });

  it('uploads an avatar, derives icons and serves the original back', async () => {
    const png = await opaquePng();
    const res = await fetch(`${baseUrl}/sales/identity/avatar`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: png,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as IdentityBody;
    assert.notEqual(body.identity.avatar, null);
    assert.equal(body.resolved.has_avatar, true);
    // An opaque source has no silhouette to derive — said out loud, not
    // silently answered with a white square.
    assert.equal(body.outline_derived, false);

    const stored = identityStore.avatars.get('agent-1');
    assert.ok(stored, 'the derived avatar reached the store');
    const colorMeta = await sharp(Buffer.from(stored.color)).metadata();
    assert.equal(colorMeta.width, 192);
    assert.equal(colorMeta.height, 192);
    assert.equal(stored.outline, null);

    const served = await fetch(`${baseUrl}/sales/identity/avatar`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.equal(
      Buffer.from(await served.arrayBuffer()).byteLength,
      png.byteLength,
    );
  });

  it('derives an outline icon when the picture has transparency', async () => {
    const transparent = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 32,
              height: 32,
              channels: 4,
              background: { r: 0, g: 0, b: 255, alpha: 1 },
            },
          })
            .png()
            .toBuffer(),
          top: 16,
          left: 16,
        },
      ])
      .png()
      .toBuffer();
    const res = await fetch(`${baseUrl}/sales/identity/avatar`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: transparent,
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as IdentityBody).outline_derived, true);
    const stored = identityStore.avatars.get('agent-1');
    assert.ok(stored?.outline, 'an outline was derived');
    const meta = await sharp(Buffer.from(stored.outline)).metadata();
    assert.equal(meta.width, 32);
    assert.equal(meta.height, 32);
  });

  it('refuses a body that is not a decodable image, and stores nothing', async () => {
    const res = await fetch(`${baseUrl}/sales/identity/avatar`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: Buffer.from('this is not a png'),
    });
    assert.equal(res.status, 400);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      'invalid_avatar',
    );
    assert.equal(identityStore.avatars.size, 0);
  });

  it('refuses a content type the route does not accept', async () => {
    const res = await fetch(`${baseUrl}/sales/identity/avatar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ not: 'an image' }),
    });
    assert.equal(res.status, 415);
    assert.equal(identityStore.avatars.size, 0);
  });

  it('removing an avatar that was never uploaded is not an error', async () => {
    const res = await fetch(`${baseUrl}/sales/identity/avatar`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as IdentityBody).identity.avatar, null);
  });

  it('answers 404 for an agent that does not exist', async () => {
    const res = await fetch(`${baseUrl}/ghost/identity`);
    assert.equal(res.status, 404);
  });

  // ── the Teams consequence (#914 acceptance criterion) ────────────────

  it('an identity edit on an INSTALLED agent enqueues a republish run', async () => {
    teamsStore.row = installedTeamsRow();
    const res = await fetch(`${baseUrl}/sales/identity`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Vertrieb' }),
    });
    assert.equal(((await res.json()) as IdentityBody).republish, 'queued');
    assert.deepEqual(teamsRunner.runs, [
      { agentId: 'agent-1', teamId: '19:team-abc', republish: true },
    ]);
  });

  it('a save that changes nothing does not queue a republish', async () => {
    teamsStore.row = installedTeamsRow();
    const payload = JSON.stringify({ display_name: 'Vertrieb' });
    await fetch(`${baseUrl}/sales/identity`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    teamsRunner.runs = [];
    const res = await fetch(`${baseUrl}/sales/identity`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(((await res.json()) as IdentityBody).republish, 'not_needed');
    assert.deepEqual(teamsRunner.runs, []);
  });

  it('says there is no installed app instead of claiming a publish', async () => {
    teamsStore.row = undefined;
    const res = await fetch(`${baseUrl}/sales/identity`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Vertrieb' }),
    });
    assert.equal(
      ((await res.json()) as IdentityBody).republish,
      'no_installed_app',
    );
    assert.deepEqual(teamsRunner.runs, []);
  });

  it('reports an uninstalled provisioner rather than dropping the signal', async () => {
    teamsStore.row = installedTeamsRow();
    provisionerInstalled = false;
    const res = await fetch(`${baseUrl}/sales/identity`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Vertrieb' }),
    });
    assert.equal(
      ((await res.json()) as IdentityBody).republish,
      'provisioner_unavailable',
    );
    assert.deepEqual(teamsRunner.runs, []);
  });

  it('an avatar upload on an installed agent republishes too', async () => {
    teamsStore.row = installedTeamsRow();
    const res = await fetch(`${baseUrl}/sales/identity/avatar`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: await opaquePng(),
    });
    assert.equal(((await res.json()) as IdentityBody).republish, 'queued');
    assert.equal(teamsRunner.runs[0]?.republish, true);
  });

  // ── the character block (#914 follow-up) ─────────────────────────────

  it('stores the persona and compiles it into the prompt', async () => {
    const res = await fetch(`${baseUrl}/sales/identity`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        instructions: 'You are the sales agent.',
        persona: {
          template: 'customer-service',
          axes: { directness: 95, sarcasm: 95 },
          custom_notes: 'Antworte auf Deutsch.',
        },
        quality: {
          sycophancy: 'high',
          boundaries: { presets: ['no-pii'], custom: ['Never quote prices.'] },
        },
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as IdentityBody;

    const stored = identityStore.rows.get('agent-1');
    assert.equal(stored?.persona?.template, 'customer-service');
    assert.equal(stored?.quality?.sycophancy, 'high');

    // The compiled prompt is what the agent actually speaks with, so the
    // response carries it — and it carries the family it was compiled
    // against, because the axes mean different things per family.
    const prompt = body.composed_prompt ?? '';
    assert.ok(prompt.includes('You are the sales agent.'));
    assert.ok(prompt.includes('<persona>'));
    assert.ok(prompt.includes('## Boundaries'));
    assert.ok(prompt.includes('Never quote prices.'));
    assert.equal(body.composed_family, 'opus');
    assert.equal(stored?.composed.text, prompt);
  });

  it('reloads the registry when the compiled prompt changed', async () => {
    reloads = 0;
    await fetch(`${baseUrl}/sales/identity`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: { axes: { directness: 95 } } }),
    });
    // Without this the edit would be stored, reported as saved, and never
    // spoken: the registry keeps serving the Orchestrator it already built.
    assert.equal(reloads, 1);
  });

  it('does not reload when only the nameplate changed', async () => {
    reloads = 0;
    await fetch(`${baseUrl}/sales/identity`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Vertrieb' }),
    });
    // A name is not a prompt — rebuilding every Agent for it would drop live
    // sessions for a label change.
    assert.equal(reloads, 0);
  });

  it('rejects an axis outside the 0-100 range', async () => {
    const res = await fetch(`${baseUrl}/sales/identity`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: { axes: { directness: 140 } } }),
    });
    assert.equal(res.status, 400);
    assert.equal(identityStore.rows.size, 0, 'nothing reached the store');
  });

  it('rejects an axis this platform does not have', async () => {
    const res = await fetch(`${baseUrl}/sales/identity`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: { axes: { charisma: 70 } } }),
    });
    // The spec schema is strict; a typo must not be stored as a setting that
    // silently does nothing.
    assert.equal(res.status, 400);
  });

  it('names boundary presets it could not resolve', async () => {
    const res = await fetch(`${baseUrl}/sales/identity`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quality: {
          boundaries: { presets: ['no-pii', 'from-the-future'], custom: [] },
        },
      }),
    });
    const body = (await res.json()) as IdentityBody;
    assert.deepEqual(body.dropped_boundary_presets, ['from-the-future']);
  });

  it('a persona edit on an INSTALLED agent republishes the package', async () => {
    teamsStore.row = installedTeamsRow();
    const res = await fetch(`${baseUrl}/sales/identity`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: { axes: { warmth: 90 } } }),
    });
    // The persona changes no text column at all — a republish gate that only
    // watched the nameplate would call this "unchanged".
    assert.equal(((await res.json()) as IdentityBody).republish, 'queued');
  });

  it('503s with a code of its own while the identity store is not wired', async () => {
    identityWired = false;
    for (const [method, path] of [
      ['GET', '/sales/identity'],
      ['PUT', '/sales/identity'],
      ['DELETE', '/sales/identity/avatar'],
      ['GET', '/sales/identity/avatar'],
    ] as const) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        ...(method === 'PUT'
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({}),
            }
          : {}),
      });
      assert.equal(res.status, 503, `${method} ${path}`);
      assert.equal(
        ((await res.json()) as { error: string }).error,
        'agent_identity_unavailable',
      );
    }
  });
});
