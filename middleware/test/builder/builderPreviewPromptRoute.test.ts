import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import { registerBuilderPreviewPromptRoute } from '../../src/routes/builderPreviewPrompt.js';

declare module 'express-serve-static-core' {
  interface Request {
    session?: { email?: string };
  }
}

interface SessionFixture {
  email: string;
}

async function bootServer(
  draftStore: DraftStore,
  session: SessionFixture,
): Promise<{ url: string; server: Server }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { email: session.email };
    next();
  });
  const router = express.Router();
  registerBuilderPreviewPromptRoute(router, { draftStore });
  app.use('/v1/builder', router);

  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('builderPreviewPrompt route (issue #55)', () => {
  let tmpRoot: string;
  let store: DraftStore;
  let server: Server;
  let baseUrl: string;
  let draftId: string;
  const userEmail = 'alice@example.com';

  beforeEach(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'preview-prompt-'));
    store = new DraftStore({ dbPath: path.join(tmpRoot, 'drafts.db') });
    await store.open();
    const d = await store.create(userEmail, 'Weather');
    draftId = d.id;
    const boot = await bootServer(store, { email: userEmail });
    server = boot.server;
    baseUrl = boot.url;
  });

  afterEach(async () => {
    await closeServer(server);
    await store.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns sections, systemPrompt, and tokens for an empty draft', async () => {
    const res = await fetch(`${baseUrl}/v1/builder/drafts/${draftId}/preview-prompt`, {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      systemPrompt: string;
      tokens: number;
      sections: { kind: string; content: string }[];
    };
    // Empty draft → just a header section
    assert.ok(Array.isArray(body.sections));
    assert.ok(body.sections.length >= 1);
    assert.equal(body.sections[0]!.kind, 'header');
    assert.ok(body.tokens >= 1, 'token count must be at least 1 for the header');
  });

  it('emits sections in compose order [header, persona, boundaries, sycophancy, skill]', async () => {
    const draft = await store.load(userEmail, draftId);
    assert.ok(draft);
    await store.update(userEmail, draftId, {
      spec: {
        ...draft.spec,
        description: 'Beantwortet Wetteranfragen.',
        skill: { role: 'Weather Agent', tonality: 'freundlich' },
        persona: {
          template: 'customer-service',
          axes: { directness: 90 },
          custom_notes: 'auf Deutsch antworten',
        },
        quality: {
          sycophancy: 'medium',
          boundaries: { presets: ['no-pii'], custom: ['keine Spekulationen'] },
        },
      },
    });

    const res = await fetch(`${baseUrl}/v1/builder/drafts/${draftId}/preview-prompt`, {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      systemPrompt: string;
      tokens: number;
      sections: { kind: string; content: string }[];
    };
    const kinds = body.sections.map((s) => s.kind);
    // First entry must be header; remaining respect the issue's compose order
    assert.equal(kinds[0], 'header');
    // Each kind appears at most once and the relative order is preserved
    const order: Record<string, number> = {
      header: 0,
      persona: 1,
      custom_notes: 2,
      boundaries: 3,
      sycophancy: 4,
      skill: 5,
    };
    let lastIdx = -1;
    for (const kind of kinds) {
      const idx = order[kind];
      assert.ok(idx !== undefined, `unexpected section kind: ${kind}`);
      assert.ok(idx >= lastIdx, `out-of-order kind: ${kind}`);
      lastIdx = idx;
    }
    // All key sections present
    assert.ok(kinds.includes('persona'));
    assert.ok(kinds.includes('boundaries'));
    assert.ok(kinds.includes('sycophancy'));
    assert.ok(kinds.includes('skill'));
    // systemPrompt is non-empty and includes content from each section.
    // Sycophancy=medium renders the "Critical Thinking" header.
    assert.match(body.systemPrompt, /Boundaries/);
    assert.match(body.systemPrompt, /Critical Thinking Guidelines/);
    assert.ok(body.tokens > 10);
  });

  it('omits missing sections silently', async () => {
    // Default draft has no persona / boundaries / sycophancy → only the
    // header and (after seeding skill) the skill block are present.
    const draft = await store.load(userEmail, draftId);
    assert.ok(draft);
    await store.update(userEmail, draftId, {
      spec: { ...draft.spec, skill: { role: 'Just a role' } },
    });

    const res = await fetch(`${baseUrl}/v1/builder/drafts/${draftId}/preview-prompt`, {
      method: 'POST',
    });
    const body = (await res.json()) as {
      sections: { kind: string }[];
    };
    const kinds = body.sections.map((s) => s.kind);
    assert.equal(kinds.includes('persona'), false);
    assert.equal(kinds.includes('boundaries'), false);
    assert.equal(kinds.includes('sycophancy'), false);
    assert.equal(kinds.includes('skill'), true);
  });

  it('404 when the draft is unreachable by the calling user', async () => {
    const res = await fetch(`${baseUrl}/v1/builder/drafts/does-not-exist/preview-prompt`, {
      method: 'POST',
    });
    assert.equal(res.status, 404);
  });
});
