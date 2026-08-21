/**
 * Shared harness for the `/api/v1/admin/transcription-provider` route tests
 * (#584 WS T). Same convention as `adminEmbeddingProvider.harness.ts` — the
 * `.harness.ts` suffix keeps it out of the test-file glob.
 *
 * Models the runtime the way it actually behaves: `activate(id)` publishes
 * that plugin's service into a SINGLE capability slot and `deactivate(id)`
 * withdraws it, so "the target activated but published nothing" (missing API
 * key) and "activation threw" are both expressible — the two rollback paths
 * the switch must survive.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { TranscriptionService } from '@omadia/plugin-api';
import express from 'express';
import { Agent, fetch as undiciFetch } from 'undici';

import { createAdminTranscriptionProviderRouter } from '../src/routes/adminTranscriptionProvider.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';

export const OPENAI_STT = '@omadia/transcription-adapter-openai';
export const OTHER_STT = '@omadia/transcription-adapter-other';
export const KG_NEON = '@omadia/knowledge-graph-neon';

function fakeService(providerId: string): TranscriptionService {
  return {
    providerId,
    transcribeFile: async () => ({
      text: '',
      segments: [],
      provider: providerId,
    }),
    transcribeStream: () => {
      throw new Error('not under test');
    },
  };
}

const SERVICES: Readonly<Record<string, TranscriptionService>> = {
  [OPENAI_STT]: fakeService('openai:gpt-transcribe'),
  [OTHER_STT]: fakeService('other:whisper-local'),
};

interface CatalogEntry {
  plugin: { id: string; name: string; provides: readonly string[] };
}

export const CATALOG_ENTRIES: readonly CatalogEntry[] = [
  {
    plugin: {
      id: OPENAI_STT,
      name: 'Transkription (OpenAI)',
      provides: ['transcription@1'],
    },
  },
  {
    plugin: {
      id: OTHER_STT,
      name: 'Transcription (Other)',
      provides: ['transcription@1'],
    },
  },
  {
    plugin: {
      id: KG_NEON,
      name: 'Knowledge Graph (Neon)',
      // A malformed entry alongside a valid one — the loader tolerates it, so
      // the router must too rather than dropping the whole plugin.
      provides: ['knowledgeGraph@1', 'not a capability ref'],
    },
  },
];

export interface SnapshotResponse {
  providers: Array<{
    pluginId: string;
    label: string;
    active: boolean;
    registryStatus: string | null;
  }>;
  activeProviderId: string | null;
  capabilityPublished: boolean;
  activeProvider: string | null;
}

export interface Harness {
  server: Server;
  dispatcher: Agent;
  registry: InMemoryInstalledRegistry;
  /** Which plugin currently owns the single `transcription@1` slot. */
  state: {
    publishedBy: string | null;
    calls: string[];
    failActivation: Set<string>;
    publishNothing: Set<string>;
    /** When set, `activate()` awaits it — lets a test hold a switch mid-flight
     *  to exercise the `switch_in_progress` serialisation. */
    activateGate: (() => Promise<void>) | null;
  };
  getJson(): Promise<{ status: number; body: SnapshotResponse }>;
  postSwitch(
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

export async function makeHarness(
  installed: ReadonlyArray<{ id: string; status?: 'active' | 'inactive' }>,
): Promise<Harness> {
  const registry = new InMemoryInstalledRegistry();
  for (const p of installed) {
    await registry.register({
      id: p.id,
      installed_version: '0.1.0',
      installed_at: new Date().toISOString(),
      status: p.status ?? 'active',
      config: {},
    });
  }

  const state = {
    publishedBy: null as string | null,
    calls: [] as string[],
    failActivation: new Set<string>(),
    publishNothing: new Set<string>(),
    activateGate: null as (() => Promise<void>) | null,
  };
  const initiallyActive = installed.find(
    (p) => (p.status ?? 'active') === 'active' && p.id in SERVICES,
  );
  state.publishedBy = initiallyActive?.id ?? null;

  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin/transcription-provider',
    createAdminTranscriptionProviderRouter({
      installedRegistry: registry,
      catalog: {
        list: () => CATALOG_ENTRIES,
        get: (id) => CATALOG_ENTRIES.find((e) => e.plugin.id === id),
      },
      getTranscription: () =>
        state.publishedBy !== null ? SERVICES[state.publishedBy] : undefined,
      activate: async (id) => {
        state.calls.push(`activate:${id}`);
        if (state.activateGate) await state.activateGate();
        if (state.failActivation.has(id)) {
          throw new Error(`activation of ${id} exploded`);
        }
        if (!state.publishNothing.has(id)) state.publishedBy = id;
      },
      deactivate: async (id) => {
        state.calls.push(`deactivate:${id}`);
        if (state.publishedBy === id) state.publishedBy = null;
        return true;
      },
    }),
  );

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve(s);
    });
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(port)}/api/v1/admin/transcription-provider`;
  const dispatcher = new Agent();

  return {
    server,
    dispatcher,
    registry,
    state,
    async getJson() {
      const res = await undiciFetch(baseUrl, { dispatcher });
      return {
        status: res.status,
        body: (await res.json()) as SnapshotResponse,
      };
    },
    async postSwitch(body: unknown) {
      const res = await undiciFetch(`${baseUrl}/switch`, {
        dispatcher,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return {
        status: res.status,
        body: (await res.json()) as Record<string, unknown>,
      };
    },
    async close() {
      await dispatcher.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
